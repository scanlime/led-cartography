/*
 * fadecandy.js - Instead of speaking the device-agnostic Open Pixel Control protocol,
 *                this is a WebSocket client which uses the native fcserver API,
 *                capable of detecting and configuring specific attached devices.
 *
 * Not ready for general-purpose use yet; so far this is pretty minimal, and doesn't
 * handle devices connecting or disconnecting at runtime.
 *
 * Copyright (c) 2015 Micah Scott
 * Released under the MIT license.
 */

(function () {

    var WebSocket = require('ws');
    var async = require('async');
    var sprintf = require('sprintf-js').sprintf;

    var fadecandy = {};

    fadecandy.DEFAULT_TIMEOUT = 4000;
    fadecandy.LEDS_PER_DEVICE = 512;
    fadecandy.LEDS_PER_STRIP = 64;

    fadecandy.ledInfo = function(devSerial, index) {
        // Return verbose information about an LED, given its FC controller serial number and index

        return {
            device: devSerial,
            index: index,
            stripIndex: (index / fadecandy.LEDS_PER_STRIP)|0,
            stripPosition: (index % fadecandy.LEDS_PER_STRIP)|0,
            string: sprintf('%s-%03d', devSerial, index),
        };
    }

    fadecandy.ledsForDevice = function(devSerial) {
        // Return a list of LEDs for objects describing the potential LEDs we may find on a list of FC devices.

        var results = [];
        for (var i = 0; i < fadecandy.LEDS_PER_DEVICE; i++) {
            results.push(fadecandy.ledInfo(devSerial, i));
        }
        return results;
    }

    fadecandy.ledsForDeviceList = function(devices) {
        // Return a list of objects describing the potential LEDs we may find on a list of FC devices.

        var results = [];
        for (var i = 0; i < devices.length; i++) {
            results = results.concat(fadecandy.ledsForDevice(devices[i].serial));
        }
        return results;
    }

    fadecandy.ConfigFactory = function() {
        var config = {};

        config.json = {
            listen: [ "127.0.0.1", 7890 ],
            verbose: true,
            color: { gamma: 2.5, whitepoint: [ 1, 1, 1 ] },
            devices: []
        };

        config.opcPixelCount = 0;

        config.mapDevice = function (serial) {
            /*
             * Find or create a device entry for a Fadecandy board with the given serial.
             * Returns the JSON node.
             */

            for (var i = 0; i < config.json.devices.length; i++) {
                var node = config.json.devices[i];
                if (node.type == 'fadecandy' && node.serial == serial) {
                    return node;
                }
            }

            var node = { type: 'fadecandy', serial: serial, map: [] };
            config.json.devices.push(node);
            return node;
        }

        config.mapPixel = function (device, index) {
            /*
             * Append a single device pixel to the mapping, returning the new OPC
             * pixel index. Consolidates contiguous mappings.
             *
             * Only supports channel 0 mappings of the form:
             * [ OPC Channel, First OPC Pixel, First output pixel, Pixel count ]
             */

            var devMap = config.mapDevice(device).map;
            var opcIndex = config.opcPixelCount++;
            var last = devMap[devMap.length - 1];

            if (last && last.length == 4
                && last[1] + last[3] == opcIndex
                && last[2] + last[3] == index) {
                // We can extend the last mapping
                last[3]++;
            } else {
                // New mapping line
                devMap.push([ 0, opcIndex, index, 1 ]);
            }

            return opcIndex;
        }

        return config;
    }

    fadecandy.connect = function(url, callback) {
        var connection = {};

        connection.socket = new WebSocket(url);
        connection.devices = [];
        connection.pending = {};
        connection.sequence = 1;

        connection.message = function (obj, callback, timeout) {
            timeout = timeout || fadecandy.DEFAULT_TIMEOUT;

            obj.sequence = connection.sequence;
            connection.sequence += 1;
            var msgText = JSON.stringify(obj);

            var timer = setTimeout( function timedOut() {
                callback('Timed out waiting for fcserver to respond to this message: ' + msgText);
                delete connection.pending[obj.sequence];
            }, timeout);

            connection.pending[obj.sequence] = function (obj) {
                callback(null, obj);
                delete connection.pending[obj.sequence];
                clearTimeout(timer);
            }

            connection.socket.send(JSON.stringify(obj));
        };

        connection.socket.on('message', function message(data, err) {
            var obj = JSON.parse(data);
            connection.pending[obj.sequence](obj);
        });

        connection.socket.on('open', function open() {
            connection.message( {type: 'list_connected_devices'} , function (err, obj) {
                if (err) return callback(err);

                // Sort device list by serial number, for a stable ordering
                connection.devices = obj.devices;
                connection.devices.sort(function (a, b) {
                    return a.serial.localeCompare(b.serial);
                });

                for (var i = 0; i < connection.devices.length; i++) {
                    console.log("Found Fadecandy device " + connection.devices[i].serial)
                }

                callback(null, connection);
            });
        });

        connection.rawPixels = function (device, rgb, callback) {
            // Disable interpolation, dithering, and gamma correction.
            // Bypasses the mapping layer, and sends RGB values straight to a single FC device.

            // Convert to raw array if necessary, so JSON serialize works
            if (rgb.constructor != Array) {
                rgb = Array.prototype.slice.call(rgb);
            }

            async.series([
                async.apply(connection.message, {
                    type: 'device_options',
                    device: device,
                    options: {
                        led: null,
                        dither: false,
                        interpolate: false
                    },
                }),
                async.apply(connection.message, {
                    type: 'device_color_correction',
                    device: device,
                    color: {
                        gamma: 1.0,
                        whitepoint: [1.0, 1.0, 1.0]
                    },
                }),
                async.apply(connection.message, {
                    type: 'device_pixels',
                    device: device,
                    pixels: rgb,
                }),
            ], callback);
        }

        connection.lightsOff = function (callback) {
            // Turn all lights off, on all devices

            async.map(connection.devices, function (thisDevice, callback) {
                var array = new Uint8Array(fadecandy.LEDS_PER_DEVICE * 3);
                connection.rawPixels(thisDevice, array, callback);
            }, callback);
        }

        connection.singleLight = function (device, index, callback) {
            // Turn a single light on at full brightness, and all others off

            async.map(connection.devices, function (thisDevice, callback) {
                var array = new Uint8Array(fadecandy.LEDS_PER_DEVICE * 3);
                if (device.serial == thisDevice.serial) {
                    for (var i = 0; i < 3; i++) {
                        array[3*index + i] = 255;
                    }
                }
                connection.rawPixels(thisDevice, array, callback);
            }, callback);
        }
    }

    module.exports = fadecandy;

}());