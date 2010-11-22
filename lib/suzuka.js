#! /usr/bin/env node

var child_process  = require('child_process'),
    http           = require('http'),
    io             = require('socket.io'),
    net            = require('net'),
    fs             = require('fs'),
    net_binding    = process.binding('net'),
    sys            = require('sys'),
    url            = require('url'),
    daemon         = require("daemon"),
    dns            = require("dns"),
    stdin,
    stdout,
    stderr,
    privatePublishPath = '/suzuka/publish/private';

/* Parent process */

function daemonise () {
    var pid = daemon.start();
    daemon.lock("/var/run/suzuka.pid");
    dropPrivileges();
    daemon.closeIO();
    stdin  = fs.openSync('/dev/null', 'r');
    stdout = fs.openSync('/var/log/suzuka/log', 'a');
    stderr = fs.openSync('/var/log/suzuka/errors', 'a');
    process.umask(027);
    process.chdir('/');
}

function dropPrivileges () {
    try {
        process.setgid('suzuka');
        process.setuid('suzuka');
    }
    catch (err) {
        sys.error('failed to set user and group');
        process.exit(1);
    }
}

function parentMain(port, siblings, restrict, shouldDaemonise, staticRoot, publicPublishPath) {
    var listen_fd = net_binding.socket('tcp4'),
        children = [],
        child;

    net_binding.bind(listen_fd, port);

    if (shouldDaemonise) {
        daemonise();
    }

    process.nextTick(function () {
        net_binding.listen(listen_fd, 128);

        for (var i = 0; i < 8; ++i) {
            child = startChild(listen_fd, restrict, staticRoot, publicPublishPath, function (raw) {
                var data = JSON.parse(raw);
                if (data.message) {
                    // One of the child processes received a POST
                    if (data.share && siblings.length > 0) {
                        // If the data needs to be shared, POST it to each of the
                        // sibling servers
                        var message = data.message;
                        siblings.forEach(function (u) {
                            var poster = http.createClient(u.port, u.hostname),
                                request;
                            request = poster.request('POST', privatePublishPath);
                            request.write(message);
                            request.end();
                        });
                    }

                    // Send the data to each child process, to be broadcast to the
                    // connected clients
                    var wrapped = wrapMessage(raw);
                    children.forEach(function (c) {
                        c.tunnel.write(wrapped, 'utf-8');
                    });
                }
            });
            children.push(child);
        }

    });
}

function startChild(listen_fd, restrict, staticRoot, publicPublishPath, onreceive) {
    var control = net_binding.socketpair(),
        tunnel = net_binding.socketpair();

    var child = child_process.spawn(
        process.argv[0],
        [process.argv[1], '--slave', '--staticroot=' + staticRoot, '--publishpath=' + publicPublishPath],
        {customFds: [control[0], 1, 2]}
    );

    process.on("exit", function () {
        child.kill();
    });

    process.on("error", function () {
        sys.error('killing child after process error');
        child.kill();
    });

    child.control = new net.Stream(control[1], 'unix');
    child.control.write('x', 'utf-8', listen_fd);
    child.control.write('x', 'utf-8', tunnel[0]);

    child.tunnel = new net.Stream(tunnel[1], 'unix');
    child.tunnel.setEncoding('utf-8');
    child.tunnel.write(wrapMessage(JSON.stringify({
        'restrict': restrict
    })));

    child.tunnel.addListener('data', makeReader(onreceive));
    child.tunnel.resume();

    return child;
}


/* Child process */

function childMain(staticRoot, publicPublishPath) {
    var listen_fd = null,
        tunnel = null,
        stdin = new net.Stream(0, 'unix');

    stdin.addListener('fd', function (fd) {
        if (listen_fd === null) {
            listen_fd = fd;
        }
        else {
            tunnel = new net.Stream(fd, 'unix');
            tunnel.setEncoding('utf-8');
            startServer(listen_fd, tunnel, staticRoot, publicPublishPath);
        }
    });
    stdin.addListener('end', function () {
        sys.debug('child ' + process.pid + ' lost connection to parent, exiting');
        process.exit(1);
    });

    stdin.resume();
}

function startServer(listen_fd, tunnel, staticRoot, publicPublishPath) {
    var num_clients = 0,
        restrict = [],
        server,
        socket,
        iframeProxy = fs.readFileSync(staticRoot + '/iframeproxy.html', 'utf8'),
        testHtml    = fs.readFileSync(staticRoot + '/test.html', 'utf8').replace('<%= PUBLISH_PATH %>', publicPublishPath),
        suzukaJs    = fs.readFileSync(staticRoot + '/suzuka.js', 'utf8');


    tunnel.addListener('data', makeReader(function (data) {
        data = JSON.parse(data);
        if (data.restrict) {
            restrict = data.restrict;
        }
        else if (data.message) {
            socket.broadcast(data.message);
        }
    }));

    server = http.createServer(function (req, res) {
        if (req.method === 'GET' && req.url === '/iframeproxy') {
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.write(iframeProxy);
            res.end();
        }
        if (req.method === 'GET' && req.url === '/test') {
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.write(testHtml);
            res.end();
        }
        else if (req.method === 'GET' && req.url === '/suzuka.js') {
            res.writeHead(200, {'Content-Type': 'text/javascript'});
            res.write(suzukaJs);
            res.end();
        }
/*        else if (req.method === 'GET' && req.url === '/socketio.js') {
            res.writeHead(200, {'Content-Type': 'text/javascript'});
            res.write(socketIoClient);
            res.end();
        }
*/
        else if (req.method === 'POST' && (req.url === privatePublishPath || req.url === publicPublishPath)) {
            var body = '';
            req.addListener('data', function (data) {
                body += data;
            });
            req.addListener('end', function () {
                var src = req.connection.remoteAddress,
                    matchesSrc = function (ip) { return ip === src; };
                if (restrict.length > 0 && !restrict.some(matchesSrc)) {
                    sys.error('ignoring data from: ' + src);
                    res.writeHead(403, {'Content-Type': 'text/plain'});
                    res.write("Forbidden\n");
                    res.end();
                }
                else {
                    var data = {message: body};
                    data.share = (req.url === publicPublishPath);
                    // Send the data to the parent process, where it can be sent to
                    // any sibling servers (if data.share is true), and distributed
                    // to each of the child processes (including this one) to be
                    // broadcast to all connected clients
                    tunnel.write(wrapMessage(JSON.stringify(data)), 'utf-8');
                    res.writeHead(200, {'Content-Type': 'text/plain'});
                    res.write("OK\n");
                    res.end();
                }
            });
        }
        else if (req.method === 'POST') {
            sys.error('POST to ' + req.url + ' not handled - configured PUBLISH_PATH is ' + publicPublishPath + ' (see /etc/sysconfig/suzuka)');
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.write('Not found');
            res.end();
        }
        else {
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.write('Not found');
            res.end();
        }
    });

    socket = io.listen(server, {
//        log: function () { },
//        transports: ['websocket', 'flashsocket', 'server-events', 'htmlfile', 'xhr-multipart', 'xhr-polling'],
        timeout: 30 * 1000
    });
    socket.on('connection', function (client) {
        num_clients++;
        sys.debug('connection in ' + process.pid);
        client.on('message', function (data) {
            sys.debug('client sent: ' + data);
        });
        client.on('disconnect', function () {
            num_clients--;
            sys.debug('client disconnected');
        });
    });
    server.listenFD(listen_fd);
    tunnel.resume();
}


/* Common functions */

function wrapMessage(data) {
    return data.length + ':' + data;
}

function makeReader(callback) {
    var length = -1,
        data = '';

    // Messages are received as
    //   <length> ':' <data>
    // for example
    //    7:example
    //    11:hello world
    //
    // This function accumulates the raw input data and alternates between
    // looking for the ':' delimiter and waiting for <length> characters.
    // Each complete <data> value is passed to the callback function.
    return function (raw) {
        data += raw;
        while (true) {
            if (length === -1) {
                var i = data.indexOf(':');
                if (i === -1) {
                    break;
                }
                else {
                    length = parseInt(data.substr(0, i), 10);
                    data = data.substr(i + 1);
                }
            }
            else if (data.length >= length) {
                callback(data.substr(0, length));
                data = data.substr(length);
                length = -1;
            }
            else {
                break;
            }
        }
    };
}

function resolveRestrictions (restrict, then) {
    if (restrict.length === 0) {
        return then(restrict);
    }
    var newRestrict = [];
    for (var i = 0, l = restrict.length; i < l; i++) {
        dns.lookup(restrict[i], function (err, address) {
            if (err) {
                throw err;
            }
            newRestrict.push(address);
            if (newRestrict.length === l) {
                then(newRestrict);
            }
        });
    }
}

function main() {
    var notEmpty          = function (v) { return !!v; },
        args              = process.argv.slice(2),
        match,
        master            = true,
        daemonise         = false
        port              = 8000,
        siblings          = [],
        restrict          = [],
        staticRoot        = __dirname.replace(/\/lib/, "") + '/static',
        publicPublishPath = '/suzuka/publish';

    for (var i = 0, l = args.length; i < l; i++) {
        if (args[i].match(/^--help$/)) {
            sys.puts('usage: suzuka [ --port=LISTEN_PORT ] [ --siblings=URL,... ] [ --restrict=IP,... ] [ --daemonise ] [ --staticroot=ROOT ]');
            process.exit(0);
        }
        else if (args[i].match(/^--slave$/)) {
            master = false;
        }
        else if (args[i].match(/^--daemonise$/)) {
            daemonise = true;
        }
        else if (match = args[i].match(/^--port=(\d+)$/)) {
            port = parseInt(match[1], 10);
        }
        else if (match = args[i].match(/^--staticroot=(\S+)$/)) {
            staticRoot = match[1];
        }
        else if (match = args[i].match(/^--publishpath=(\S+)$/)) {
            publicPublishPath = match[1];
        }
        else if (match = args[i].match(/^--siblings=(.+)$/)) {
            siblings = match[1].split(',').filter(notEmpty).map(function (s) {
                return s.split(':');
            });
        }
        else if (match = args[i].match(/^--restrict=(.+)$/)) {
            restrict = match[1].split(',').filter(notEmpty);
        }
        else {
            sys.puts('suzuka: unrecognised option ' + args[i]);
            process.exit(1);
        }
    }

    if (master) {
        for (var i = 0, l = siblings.length; i < l; i++) {
            siblings[i] = {
                'hostname' : siblings[i][0],
                'port'     : parseInt(siblings[i][1] || port, 10)
            };
            if (restrict.length > 0) {
                restrict.push(siblings[i].hostname);
            }
        }

        resolveRestrictions(restrict, function (restrict) {
            parentMain(port, siblings, restrict, daemonise, staticRoot, publicPublishPath);
        });
    }
    else {
        childMain(staticRoot, publicPublishPath);
    }
}

main();
