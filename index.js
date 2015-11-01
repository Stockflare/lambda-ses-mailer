exports.handler = function(event, context) {
  var Mustache = require("mustache");
  var When = require('when');
  var Aws = require("aws-sdk");

  // load SES and S3 objects for entire of record processing
  var ses = new Aws.SES();
  var s3 = new Aws.S3();

  // begin processing all the received records..
  var promises = event.Records.map(function(record) {
    return When.promise(function(resolve, reject, notify) {
      // base64 decode, convert to ascii and JSON parse this kinesis record's payload
      var payload = JSON.parse(new Buffer(record.kinesis.data, 'base64').toString('ascii'));

      console.log('Loading template ' + payload.Email.Properties.TemplateKey + ' in ' + payload.Configuration.Bucket);

      // helper function to simplify params to retrieve html/txt/etc files using s3 bucket & key
      var _ext = function(ext) {
        return { Bucket: payload.Configuration.Bucket, Key: payload.Email.Properties.TemplateKey + '.' + ext }
      };

      // retrieve the html file from s3
      s3.getObject(_ext('html'), function(err, html) {
        if (err) reject(err); else {
          // OK! now retrieve the txt file from s3
          s3.getObject(_ext('txt'), function(err, txt) {
            if (err) reject(err); else {
              // inject the rendered HTML & TXT messages into the payload to be sent to SES
              payload.Email.Payload.Message  = {
                Body: {
                  Html: {
                    Data: Mustache.render(html.Body.toString(), payload.Email.Properties.Data),
                    Charset: 'UTF-8'
                  },
                  Text: {
                    Data: Mustache.render(txt.Body.toString(), payload.Email.Properties.Data),
                    Charset: 'UTF-8'
                  }
                },
                Subject: {
                  // also set the configured subject
                  Data: payload.Email.Properties.Subject,
                  Charset: 'UTF-8'
                }
              }
              // send the email and resolve the promise. Or reject on error
              ses.sendEmail(payload.Email.Payload, function (err, data) {
                if (err) reject(err); else resolve({});
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
