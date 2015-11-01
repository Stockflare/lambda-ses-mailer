exports.handler = function(event, context) {
  var Mustache = require("mustache");
  var When = require('when');
  var Aws = require("aws-sdk");

  var auth = { accessKeyId: 'AKIAJ7T4V2A2LKZNE7SA', secretAccessKey: '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', region: 'us-east-1' };

  // load SES and S3 objects for entire of record processing
  var ses = new Aws.SES(auth);
  var s3 = new Aws.S3(auth);

  // // load SES and S3 objects for entire of record processing
  // var ses = new Aws.SES();
  // var s3 = new Aws.S3();

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

      var _data = function(params, fnc) {
        s3.headObject(params, function(err, data) {
          if (err && err.code === 'Not Found') fnc(null); else {
            s3.getObject(params, function(err, data) {
              if (err) reject(err); else fnc(data.Body.toString());
            });
          }
        });
      };

      _data(_ext('subj'), function(subject) {
        if( ! subject) reject('missing .subj'); else {
          _data(_ext('html'), function(html) {
            _data(_ext('txt'), function(txt) {
              payload.Email.Payload.Message = {
                Body: {},
                Subject: {
                  // also set the configured subject
                  Data: Mustache.render(subject, payload.Email.Properties.Data),
                  Charset: 'UTF-8'
                }
              };
              // if a html email exists inject it
              if(html) payload.Email.Payload.Message.Body.Html = {
                Data: Mustache.render(html, payload.Email.Properties.Data),
                Charset: 'UTF-8'
              };
              // if a text email exists inject it
              if(txt) payload.Email.Payload.Message.Body.Text = {
                Data: Mustache.render(txt, payload.Email.Properties.Data),
                Charset: 'UTF-8'
              };

              // send the email and resolve the promise. Or reject on error
              console.log(payload.Email.Payload);
              ses.sendEmail(payload.Email.Payload, function (err, data) {
                if (err) reject(err); else resolve({});
              });
            });
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
