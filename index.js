exports.handler = function(event, context) {
  var Mustache = require("mustache");
  var When = require('when');
  var Aws = require("aws-sdk");

  var s3 = new Aws.S3();

  var juice = require('juice');

  // // load SES and S3 objects for entire of record processing

  // Mime Email builder
  var MimeBuilder = require('mailbuild');

  // console.log(JSON.stringify(event.Records));
  // begin processing all the received records..
  var promises = event.Records.map(function(record) {

    var ses = new Aws.SES({ region: record.awsRegion });

    console.log(JSON.stringify(record));

    return When.promise(function(resolve, reject, notify) {
      // base64 decode, convert to ascii and JSON parse this kinesis record's payload
      var payload = JSON.parse(new Buffer(record.kinesis.data, 'base64').toString('ascii'));
      console.log(JSON.stringify(payload));

      console.log('Loading template ' + payload.Email.Properties.TemplateKey + ' in ' + payload.Configuration.Bucket);

      // helper function to simplify params to retrieve html/txt/etc files using s3 bucket & key
      var _ext = function(ext) {
        return { Bucket: payload.Configuration.Bucket, Key: payload.Email.Properties.TemplateKey + '.' + ext };
      };

      var _data = function(params, fnc) {
        s3.headObject(params, function(err, data) {
          if (err && err.code === 'NotFound') fnc(null); else {
            s3.getObject(params, function(err, data) {
              if (err) reject(err); else fnc(data.Body.toString());
            });
          }
        });
      };

      var _partials = function(fnc) {
        var partials = { html: {}, txt: {} };
        var key = payload.Email.Properties.Partials;
        // ensure partials key exists before continuing
        if(key) {
          // ensure trailing slash added to key path
          var prefix = key.replace(/\/?$/, '/');
          var regex = new RegExp('^' + prefix + '(.+)\.(html|txt)$');
          s3.listObjects({ Bucket: payload.Configuration.Bucket, Prefix: payload.Email.Properties.Partials }, function(err, data) {
            if (err) fnc(err); else {
              var files = data.Contents.map(function(content) {
                var match = content.Key.match(regex);
                if(match) return When.promise(function(resolve, reject, notify) {
                  _data({ Bucket: payload.Configuration.Bucket, Key: match[0] }, function(data) {
                    partials[match[2]][match[1]] = data;
                    resolve();
                  });
                });
              });
              When.all(files).done(function() {
                fnc(null, partials);
              }, function(reason) {
                fnc("failed to load partials: " + reason, null);
              });
            }
          });
        } else {
          fnc(null, partials);
        }
      };

      _data(_ext('subj'), function(subject) {
        if( ! subject) reject('missing .subj'); else {
          _partials(function(err, partials) {
            if(err) reject(err); else {
              _data(_ext('html'), function(html) {
                _data(_ext('txt'), function(txt) {

                  // Add in Mailer data
                  payload.Email.Properties.Data.mailer_current_year = new Date().getFullYear().toString();
                  
                  // if a html email exists inject it
                  var html_node = new MimeBuilder("text/html");
                  if (html) {
                    // Create an HTML Node
                    html_node.setContent(
                      juice(Mustache.render(html, payload.Email.Properties.Data, partials.html), { preserveImportant: true })
                    );
                  }
                  // if a text email exists inject it
                  var txt_node = new MimeBuilder("text/plain");
                  if (txt) {
                    txt_node.setContent(
                      Mustache.render(txt, payload.Email.Properties.Data, partials.txt)
                    );
                  }

                  var mail;
                  if (txt && html) {
                    mail = new MimeBuilder("multipart/alternative");
                    mail.appendChild(txt_node);
                    mail.appendChild(html_node);
                  } else {
                    if (txt) mail = txt_node;
                    if (html) mail = html_node;
                  }

                  // Set Mail headers
                  mail.setHeader('From', payload.Email.Payload.Source);
                  mail.setHeader('Reply-To', payload.Email.Payload.ReplyToAddresses.join());
                  mail.setHeader('To', payload.Email.Payload.Destination.ToAddresses.join());
                  mail.setHeader('CC', payload.Email.Payload.Destination.CcAddresses.join());
                  mail.setHeader('BCC', payload.Email.Payload.Destination.BccAddresses.join());
                  mail.setHeader('Subject', Mustache.render(subject, payload.Email.Properties.Data));

                  // send the email and resolve the promise. Or reject on error
                  var mail_params = {
                    RawMessage: {
                      Data: mail.build()
                    }
                  };

                  ses.sendRawEmail(mail_params, function(err, data) {
                    if (err) {
                      console.log('mail send error');
                      console.log(err, err.stack);
                      reject(err);
                    }
                    else {
                      console.log(data);
                      resolve();
                    }
                  });
                  // ses.sendEmail(payload.Email.Payload, function (err, data) {
                  //   if (err) reject(err); else resolve({});
                  // });
                });
              });
            }
          });
        }
      });
    });
  });

  When.all(promises).done(function(records) {
    context.succeed("Successfully processed " + event.Records.length + " records.");
  }, function(reason) {
    context.fail("Failed to process records " + reason);
  });
};
