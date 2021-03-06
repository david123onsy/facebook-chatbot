const express = require('express');
const bodyParser = require('body-parser');
const request = require('request');
const config = require('./config');
const apiai = require('apiai');
const sessionIds = new Map();
const uuid = require('uuid')

var mongoose = require("mongoose");

var db = mongoose.connect(process.env.MONGODB_URI);
var weatherDB = require("./weather");


var app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: true
}));
app.listen((process.env.PORT || 5000));


//Connecting between Facebook messenger and API.AI
const apiAiService = apiai(config.API_AI_CLIENT_ACCESS_TOKEN, {
    language: "en",
    requestSource: "fb"
});


//default route
app.get('/', (req, res) => {
    res.send("Hello");
});


//Validate that Facebook webhook is correct!
app.get("/webhook", function (req, res) {
    if (req.query['hub.mode'] && req.query["hub.verify_token"] === process.env.Verify_TOKEN) {
        //  console.log("Verified webhook");
        res.status(200).send(req.query["hub.challenge"]);
    } else {
        console.error("Verification failed. The tokens do not match.");
        res.sendStatus(403).end();
    }
});

//Handling Messages
app.post('/webhook', function (req, res) {

    //if the trigger comes from Page
    if (req.body.object === 'page') {

        //check if we have multiple entries
        req.body.entry.forEach(function (entry) {
            entry.messaging.forEach(function (event) {
                if (event.postback){
                    handlePostBack(event)
                }
                else if (event.message.attachments){
                    var lat = null;
                    var long = null;
                    if (messageAttachments[0].payload.coordinates) {
                        lat = messageAttachments[0].payload.coordinates.lat;
                        long = messageAttachments[0].payload.coordinates.long;
                    }
                    var msg = "lat : " + lat + " ,long : " + long + "\n";
                    sendTextMessage(senderID, msg);
                }
                else if (event.message && event.message.text) {
                    receivedMessage(event);
                }
            
            });
        });
        res.status(200).end();
    }
});


function receivedMessage(event) {

    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfMessage = event.timestamp;
    var message = event.message;


    if (!sessionIds.has(senderID)) {
        sessionIds.set(senderID, uuid.v1());
    }
    //Handling message Text
    var messageText = message.text;
    sendToApiAi(senderID, messageText);
}



function sendToApiAi(sender, text) {
	sendTypingOn(sender);
    //to make a request to api, we set a text and session it
    //https://dialogflow.com/docs/reference/api-v2/rest/v2beta1/WebhookRequest
    let apiaiRequest = apiAiService.textRequest(text, {
        sessionId: sessionIds.get(sender)
    });

    apiaiRequest.on('response', (response) => {
        handleApiAiResponse(sender, response);
    });

    apiaiRequest.on('error', (error) => console.error(error));
    apiaiRequest.end();
}



function handleApiAiAction(sender, action, responseText, contexts, parameters) {
    if (action === 'weather') {
        var msg;
        let city = parameters['geo-city'];
        let restUrl = 'http://api.openweathermap.org/data/2.5/weather?APPID=' + config.WEATHER_API_KEY + '&q=' + city;
        request.get(restUrl, (err, response, body) => {
            if (!err && response.statusCode == 200) {
                let json = JSON.parse(body);
                console.log(JSON.stringify(json))
                    var query = {
                        user_id: sender
                    };
                    var update = {
                        user_id: sender,
                        city: city,
                        temperature: json.main.temp,
                        description: json.weather[0].description,
                        windSpeed: json.wind.speed,
                        pressure: json.main.pressure,
                        humidity: json.main.humidity
                    };
                    var options = {
                        upsert: true
                    };
                    weatherDB.findOneAndUpdate(query, update, options, function (err, mov) {
                        if (err) {
                            console.log("Database error: " + err);
                        } else {
                            msg = json.weather[0].description + ' and the temperature is ' + json.main.temp + ' ℉ with wind speed ' + json.wind.speed;
                        }
                        sendTextMessage(sender, msg);
                        return;
                    });

            } else {
                msg = 'I failed to look up the city name.'
            }
            console.log("THE MESSAGE YA ZFT IS "+msg)
            sendTextMessage(sender, msg)
        });
    } else {
        sendTextMessage(sender, responseText);
    }
}


function handleApiAiResponse(sender, response) {
    let responseText = response.result.fulfillment.speech;
    let responseData = response.result.fulfillment.data;
    let messages = response.result.fulfillment.messages;
    let action = response.result.action;
    let contexts = response.result.contexts;
    let parameters = response.result.parameters;

    sendTypingOff(sender);

    if (responseText == '' && !isDefined(action)) {
        //api ai could not evaluate input.
        sendTextMessage(sender, "I'm not sure what you want. Can you be more specific?");
    } else if (isDefined(action)) {
        handleApiAiAction(sender, action, responseText, contexts, parameters);
    } else {
        sendTextMessage(sender, responseText);
    }
}


function sendTextMessage(recipientId, text) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: text
        }
    }
    callSendAPI(messageData);
}


function callSendAPI(messageData) {
    request({
        uri: 'https://graph.facebook.com/v2.6/me/messages',
        qs: {
            access_token: config.PAGE_ACCESS_TOKEN
        },
        method: 'POST',
        json: messageData

    }, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            var recipientId = body.recipient_id;
            var messageId = body.message_id;

            if (messageId) {
                console.log("Successfully sent message with id %s to recipient %s",
                    messageId, recipientId);
            } else {
                console.log("Successfully called Send API for recipient %s",
                    recipientId);
            }
        } else {
            console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
        }
    });
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {


	var messageData = {
		recipient: {
			id: recipientId
		},
		sender_action: "typing_on"
	};

	callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {


    var messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "typing_off"
    };

    callSendAPI(messageData);
}

function handlePostBack(event){
     var senderId = event.sender.id;
     var payload = event.postback.payload;
    console.log(payload);
     if (payload === "FACEBOOK_WELCOME") {
         request({
             url: "https://graph.facebook.com/v2.6/" + senderId,
             qs: {
                 access_token: process.env.PAGE_ACCESS_TOKEN,
                 fields: "first_name"
             },
             method: "GET"
         }, function (error, response, body) {
             var greeting = "";
             if (error) {
                 console.log("Error getting user's name: " + error);
             } else {
                 var bodyObj = JSON.parse(body);
                 name = bodyObj.first_name;
                 greeting = "Hi " + name + ". ";
             }
             var message = greeting + "My name is Weather ChatBot. I can tell you various details regarding weather";
             sendTextMessage(senderId, message);
             
         });
     }
}

function isDefined(obj) {
    if (typeof obj == 'undefined') {
        return false;
    }

    if (!obj) {
        return false;
    }

    return obj != null;
}