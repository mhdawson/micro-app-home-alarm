// Copyright 2014-2016 the project authors as listed in the AUTHORS file.
// All rights reserved. Use of this source code is governed by the
// license that can be found in the LICENSE file.
var mqtt = require('mqtt');
var path = require('path');
var fs = require('fs');
var twilio = require('twilio');
var socketio = require('socket.io');

// constants
const PAGE_HEIGHT = 320;
const PAGE_WIDTH = 390;
const NUM_ZONES = 8;
const ZONE_STATUS = '/status';
const ZONE_NAME = '/name';
const CAMERA_CAPTURE = '/capture';
const CAMERA_NEWPICTURE = '/newpicture';

// These two are filled in later as the socket io connection
// is established
var ioclient;
var eventSocket;

// alarm state and data
var alarmSite = '';
var latestData = {};
var zoneMapping = {};

///////////////////////////////////////////////
// Camera handling functions
///////////////////////////////////////////////
// camera configuration
var cameraCaptureTopic;
var pictureTimer = null;
var picture1 = '';
var picture2 = '';
var picture3 = '';
var picture4 = '';

// function to request that a picture be taken
var irTimer = undefined;
var cameraCaptureTopic;
function takePicture(mqttClient) {
   irOn(mqttClient);
   irOn(mqttClient);
   irOn(mqttClient);

   // leave some time for the ir light to illuminate
   setTimeout(function() {
                mqttClient.publish(cameraCaptureTopic, 'take');
              }, 10);

   // now give the pi 60 seconds to take the picture
   // and then turn off the ir light.  If another
   // picture request comes before the first one
   // is complete the timer is reset so we should
   // always get 60s after the request for the last
   // picture
   if (irTimer != undefined) {
      clearInterval(irTimer);
   }
   irTimer = setInterval(function() {
                           irOff(mqttClient);
                           irOff(mqttClient);
                           irOff(mqttClient);
                           clearInterval(irTimer);
                           irTimer = undefined;
                         }, 30000);
}


function irOn(mqttClient) {
   if ((undefined != Server.config.camera.IRtopic) && (undefined != Server.config.camera.IRon)) {
      mqttClient.publish(Server.config.camera.IRtopic, Server.config.camera.IRon);
   }
}


function irOff(mqttClient) {
   if ((undefined != Server.config.camera.IRtopic) && (undefined != Server.config.camera.IRoff)) {
      mqttClient.publish(Server.config.camera.IRtopic, Server.config.camera.IRoff);
   }
}


///////////////////////////////////////////////
// Logging
///////////////////////////////////////////////
var eventLogFile; 
function logEvent(event) {
 // no point to provide error function as we won't do
 // anything in case of an error
 fs.appendFile(eventLogFile, new Date() + ' :' + event + '\n');
}


///////////////////////////////////////////////
// micro-app framework methods
///////////////////////////////////////////////
var Server = function() {
}


Server.getDefaults = function() {
  return { 'title': 'Alarm Console' };
}


var replacements;
Server.getTemplateReplacments = function() {
  if (replacements === undefined) {
    var config = Server.config;
    replacements = [{ 'key': '<ALARM DASHBOARD TITLE>', 'value': config.title },
                    { 'key': '<UNIQUE_WINDOW_ID>', 'value': config.title },
                    { 'key': '<WEBSERVER_URL>', 'value': config.webserverUrlForPictures },
                    { 'key': '<WEBSERVER_URL>', 'value': config.webserverUrlForPictures },
                    { 'key': '<WEBSERVER_URL>', 'value': config.webserverUrlForPictures },
                    { 'key': '<PAGE_WIDTH>', 'value': PAGE_WIDTH },
                    { 'key': '<PAGE_HEIGHT>', 'value': PAGE_HEIGHT }];

  }
  return replacements;
}


Server.handleSupportingPages = function(request, response) {
  // ok now server the appropriate page base on the request type
  if (request.url.indexOf("getlog") > -1) {
    var logFile = fs.readFileSync(eventLogFile);
    response.writeHead(200, {'Content-Type': 'text/html'});
    response.end(logFile);
    return true;
  } 
  return false;
};


Server.startServer = function(server) {
  var config = Server.config;
  var newPictureTopic = config.camera.topic + CAMERA_NEWPICTURE;
  cameraCaptureTopic = config.camera.topic + CAMERA_CAPTURE;
  var alarmStatusTopic = config.mqtt.rootTopic +  '/alarm/status';
  var zoneTopicPrefix = config.mqtt.rootTopic + '/alarm/zone/';
  eventLogFile = path.join(Server.config.eventLogPrefix, 'alarm_event_log');

  for (var i = 0; i < config.zones.length; i++) {
    zoneMapping[config.zones[i].topic] = zoneTopicPrefix + config.zones[i].zoneId + ZONE_STATUS;
    latestData[zoneTopicPrefix + config.zones[i].zoneId + ZONE_NAME] = config.zones[i].label;
  }

  eventSocket = socketio.listen(server);

  // setup mqtt
  var mqttOptions;
  if (config.mqtt.serverUrl.indexOf('mqtts') > -1) {
    mqttOptions = { key: fs.readFileSync(path.join(__dirname, 'mqttclient', '/client.key')),
                    cert: fs.readFileSync(path.join(__dirname, 'mqttclient', '/client.cert')),
                    ca: fs.readFileSync(path.join(__dirname, 'mqttclient', '/ca.cert')),
                    checkServerIdentity: function() { return undefined }
    }
  }

  var mqttClient = mqtt.connect(config.mqtt.serverUrl, mqttOptions);

  /* each time we connect register on all topics we are interested
   * in.  This must be done after a reconnect as well as the
   * initial connect
   */
  mqttClient.on('connect',function() {
    mqttClient.subscribe(alarmStatusTopic);
    mqttClient.subscribe(zoneTopicPrefix + '+/+');
    mqttClient.subscribe(newPictureTopic);
    for(topic in zoneMapping) {
       mqttClient.subscribe(topic);
    }

    mqttClient.on('message', function(topic, message) {
      latestData[topic] = message;
      if (alarmStatusTopic == topic) { 
        if (('arm' == message) || ('disarm' == message)) {
          // first clear the state of all of the zones
          for(i=1;i < NUM_ZONES+1; i++) { 
             mqttClient.publish(zoneTopicPrefix + i + ZONE_STATUS, 'off'); 
          } 
          // stop taking pictures if we are as we are reseting the alarm state
          if (null != pictureTimer) {
            clearInterval(pictureTimer);
          }
  
          if ('arm' == message) {
            logEvent('Armed');
          } else {
            logEvent('Dis-Armed');
          }
        } else if ('triggered' == message) {
          logEvent('Alarm Triggered:' + Date());
  
          // take pictures every 10 seconds for 5 minutes after the alarm is triggered
          var count = 0;
          pictureTimer = setInterval(function() {
            takePicture(mqttClient);
            count++;
            if (30 < count) {
              clearInterval(pictureTimer);
            }
          }, 10000);
  
          // send sms message indicating alarm has been triggered
          var twilioClient = new twilio.RestClient(config.twilio.accountSID, config.twilio.accountAuthToken);
          twilioClient.sendMessage({
            to: config.twilio.toNumber,
            from: config.twilio.fromNumber,
            body: 'Alarm triggered:' +  alarmSite
          }, function(err, message) {
            if (err) { 
              logEvent('Failed to send sms:' + err.message);
            } else {
              logEvent('SMS Sent:' + message.sid);
            }
          }); 
        }
      } else if (topic == newPictureTopic) {
        // seems like we sometimes get duplicates, avoid adding these to the picture rotation
        if ((message != picture1) &&
            (message != picture2) &&
            (message != picture3) &&
            (message != picture4)) {
           picture4 = picture3
           picture3 = picture2
           picture2 = picture1
           picture1 =  message;
        }
      }
     
      if (undefined != zoneMapping[topic]) { 
        // sensor alarm, map and publish alarm event
        mqttClient.publish(zoneMapping[topic], 'on');
        logEvent('Zone triggered - ' + zoneMapping[topic]);
        
        // if we are armed then system has been triggered
        if ('arm' == latestData[alarmStatusTopic]) { 
            mqttClient.publish(alarmStatusTopic, 'triggered');
        }
      } else {
        // other message publish directly to clients
        ioclient.emit('message', topic + ":" + message);
      }
    });

    eventSocket.on('connection', function(theIoClient) {
      ioclient = theIoClient;
      for (key in latestData) {
        if (key != newPictureTopic) {
           eventSocket.to(ioclient.id).emit('message', key + ":" + latestData[key]);
        }
      }

      // send the latest pictures
      eventSocket.to(ioclient.id).emit('message', newPictureTopic + ":" + picture4);
      eventSocket.to(ioclient.id).emit('message', newPictureTopic + ":" + picture3);
      eventSocket.to(ioclient.id).emit('message', newPictureTopic + ":" + picture2);
      eventSocket.to(ioclient.id).emit('message', newPictureTopic + ":" + picture1);

      ioclient.on('message', function(event) {
        var parts = event.split(":");
        var topic = parts[0];
        var value = parts[1];
        if (topic == alarmStatusTopic) {
          mqttClient.publish(topic, value);
        } else if (topic == cameraCaptureTopic) {
          takePicture(mqttClient);
        }
      });
    });
  });

  logEvent('Alarm active');
};


if (require.main === module) {
  var path = require('path');
  var microAppFramework = require('micro-app-framework');
  microAppFramework(path.join(__dirname), Server);
}


module.exports = Server;
