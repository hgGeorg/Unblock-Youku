#!/usr/bin/env node

/*
 * Allow you smoothly surf on many websites blocking non-mainland visitors.
 * Copyright (C) 2012, 2013 Bo Zhu http://zhuzhu.org
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */


var util = require('util');
var http = require('http');
http.globalAgent.maxSockets = Infinity;
var cluster = require('cluster');

var sogou = require('../shared/sogou');
var shared_tools = require('../shared/tools');
var server_utils = require('./utils');


var local_addr, local_port, proxy_addr, run_locally;
if (process.env.PORT) {
    local_addr = '0.0.0.0';
    local_port = process.env.PORT;
    proxy_addr = 'proxy.uku.im:80';
    run_locally = false;
} else {
    local_addr = '0.0.0.0';  // '127.0.0.1';
    local_port = 8888;
    proxy_addr = server_utils.get_first_external_ip() + ':' + local_port;
    run_locally = true;
}
var pac_file_content = shared_tools.url2pac(require('../shared/urls').url_list, proxy_addr);


// what are the life cycles of variables in nodejs?
var my_date = new Date();
var sogou_server_addr;
var timeout_count = 0, MAX_TIMEOUT_COUNT = 10;
var last_error_code = null;
function change_sogou_server(error_code) {
    if (timeout_count >= MAX_TIMEOUT_COUNT) {
        return;  // should already be in the process of changing new server
    }

    if ('string' === typeof error_code) {
        last_error_code = error_code;
    } else {
        last_error_code = null;
    }
    server_utils.renew_sogou_server(function(new_addr) {
        sogou_server_addr = new_addr;
        // console.log('changed to new server: ' + new_addr);
        if (null !== last_error_code) {
            util.error('[ub.uku.js] on ' + last_error_code + 'error, changed server to ' + new_addr);
        }
        timeout_count = 0;
    });
}
    
if (cluster.isMaster) {
    var num_CPUs = require('os').cpus().length;
    // num_CPUs = 1;

    var i;
    for (i = 0; i < num_CPUs; i++) {
        cluster.fork();
        // one note here
        // the fork() in nodejs is not as the fork() in C
        // here the fork() will run the whole code from beginning
        // not from where it is invoked
    }

    cluster.on('listening', function(worker, addr_port) {
        // use ub.uku.js as keyword for searching in log files
        util.log('[ub.uku.js] Worker ' + worker.process.pid + ' is now connected to ' + addr_port.address + ':' + addr_port.port);
    });

    cluster.on('exit', function(worker, code, signal) {
        if (signal) {
            util.log('[ub.uku.js] Worker ' + worker.process.pid + ' was killed by signal: ' + signal);
        } else if (code !== 0) {
            util.error('[ub.uku.js] Worker ' + worker.process.pid + ' exited with error code: ' + code);
            // respawn a worker process when one dies
            cluster.fork();
        } else {
            util.error('[ub.uku.js] Worker ' + worker.process.pid + ' exited with no error; this should never happen');
        }
    });

    if (run_locally) {
        console.log('The local proxy server is running...\nPlease use this PAC file: http://' + proxy_addr + '/proxy.pac\n');
    }

} else if (cluster.isWorker) {
    sogou_server_addr = sogou.new_sogou_proxy_addr();
    // console.log('default server: ' + sogou_server_addr);
    change_sogou_server();
    var change_server_timer = setInterval(change_sogou_server, 10 * 60 * 1000);  // every 10 mins
    if ('function' === typeof change_server_timer.unref) {
        change_server_timer.unref();  // doesn't exist in nodejs v0.8
    }

    http.createServer(function(client_request, client_response) {
        client_request.on('error', function(err) {
            util.error('[ub.uku.js] client_request error: (' + err.code + ') ' + err.message, err.stack);
        });
        client_response.on('error', function(err) {  // does this work?
            util.error('[ub.uku.js] client_response error: (' + err.code + ') ' + err.message, err.stack);
        });

        if (run_locally) {
            console.log('[ub.uku.js] ' + client_request.connection.remoteAddress + ': ' + client_request.method + ' ' + client_request.url);
        }

        if (client_request.url === '/favicon.ico') {
            client_response.writeHead(404, {
                'Cache-Control': 'public, max-age=2592000'
            });
            client_response.end();
            return;
        }

        if (client_request.url === '/crossdomain.xml') {
            client_response.writeHead(200, {
                'Content-Type': 'text/xml',
                'Cache-Control': 'public, max-age=2592000'
            });
            client_response.end('<?xml version="1.0" encoding="UTF-8"?>\n' +
                '<cross-domain-policy><allow-access-from domain="*"/></cross-domain-policy>');
            return;
        }

        if (client_request.url === '/proxy.pac') {
            client_response.writeHead(200, {
                'Content-Type': 'application/x-ns-proxy-autoconfig',
                'Cache-Control': 'public, max-age=14400'
            });
            client_response.end(pac_file_content);
            return;
        }

        var target;
        if (shared_tools.string_starts_with(client_request.url, '/proxy') || 
                shared_tools.string_starts_with(client_request.url, 'http')) {
            target = server_utils.get_real_target(client_request.url);
        } else {
            client_response.writeHead(501, {
                'Cache-Control': 'public, max-age=14400'
            });
            client_response.end();
            return;
        }
        if (!target.host) {
            client_response.writeHead(403, {
                'Cache-Control': 'public, max-age=14400'
            });
            client_response.end();
            return;
        }

        var proxy_request_options;
        // if (true) {
        if (server_utils.is_valid_url(target.href)) {
            var sogou_auth = sogou.new_sogou_auth_str();
            var timestamp = Math.round(my_date.getTime() / 1000).toString(16);
            var sogou_tag = sogou.compute_sogou_tag(timestamp, target.hostname);

            var proxy_request_headers = server_utils.filtered_headers(client_request.headers);
            proxy_request_headers['X-Sogou-Auth'] = sogou_auth;
            proxy_request_headers['X-Sogou-Timestamp'] = timestamp;
            proxy_request_headers['X-Sogou-Tag'] = sogou_tag;
            proxy_request_headers['X-Forwarded-For'] = shared_tools.new_random_ip();
            proxy_request_headers.Host = target.host;

            proxy_request_options = {
                hostname: sogou_server_addr,
                host: sogou_server_addr,
                port: +target.port,  // but always 80
                path: target.href,
                method: client_request.method,
                headers: proxy_request_headers
            };
        } else if (run_locally) {
            // serve as a normal proxy
            client_request.headers.host = target.host;
            proxy_request_options = {
                host: target.host,
                hostname: target.hostname,
                port: +target.port,
                path: target.path,
                method: client_request.method,
                headers: server_utils.filter_headers(client_request.headers)
            };
        } else {
            client_response.writeHead(403, {
                'Cache-Control': 'public, max-age=14400'
            });
            client_response.end();
            return;
        }

        // console.log('Client Request:');
        // console.log(proxy_request_options);
        var proxy_request = http.request(proxy_request_options, function(proxy_response) {
            proxy_response.on('error', function(err) {
                util.error('[ub.uku.js] proxy_response error: (' + err.code + ') ' + err.message, err.stack);
            });
            proxy_response.pipe(client_response);

            // console.log('Server Response:');
            // console.log(proxy_response.statusCode);
            // console.log(proxy_response.headers);
            client_response.writeHead(proxy_response.statusCode, proxy_response.headers);
        });
        proxy_request.on('error', function(err) {
            util.error('[ub.uku.js] proxy_request error: (' + err.code + ') ' + err.message, err.stack);
            if ('ECONNRESET' === err.code) {
                change_sogou_server();
            } else if ('ETIMEDOUT' === err.code) {
                timeout_count += 1;
                util.log('[ub.uku.js] timeout_count: ' + timeout_count);
                if (timeout_count >= MAX_TIMEOUT_COUNT) {
                    change_sogou_server();
                }
            }
            // should we explicitly end client_response when error occurs?
            client_response.statusCode = 599;
            client_response.end();
            // should we also destroy the proxy_request object?
        });

        client_request.pipe(proxy_request);
    }).listen(local_port, local_addr);
}

process.on('uncaughtException', function(err) {
    util.error('[ub.uku.js] Caught exception: ' + err, err.stack);
    process.exit(213);
});

