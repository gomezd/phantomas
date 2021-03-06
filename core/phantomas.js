/**
 * phantomas main file
 */
/* global phantom: true, window: true */
'use strict';

/**
 * Environment such PhantomJS 1.8.* does not provides the bind method on Function prototype.
 * This shim will ensure that source-map will not break when running on PhantomJS.
 *
 * @see https://github.com/abe33/source-map/commit/61131e53ceb3b69d387da3c6daad6adbbaaae9b3
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/bind
 */
if(!Function.prototype.bind) {
	Function.prototype.bind = function(scope) {
		var self = this;
		return function() {
			return self.apply(scope, arguments);
		};
	};
}

// exit codes
var EXIT_SUCCESS = 0,
	EXIT_TIMED_OUT = 252,
	EXIT_CONFIG_FAILED = 253,
	EXIT_LOAD_FAILED = 254,
	EXIT_ERROR = 255;

// get phantomas version from package.json file
var VERSION = require('../package').version;

var getDefaultUserAgent = function() {
	var version = phantom.version,
		system = require('system'),
		os = system.os;

	return "phantomas/" + VERSION + " (PhantomJS/" + version.major + "." + version.minor + "." + version.patch + "; " + os.name + " " + os.architecture + ")";
};

var phantomas = function(params) {
	// handle JSON config file provided via --config
	var fs = require('fs'),
		jsonConfig;

	if (params.config && fs.isReadable(params.config)) {
		try {
			jsonConfig = JSON.parse( fs.read(params.config) ) || {};
		}
		catch(ex) {
			jsonConfig = {};
			params.config = false;
		}

		// allow parameters from JSON config to be overwritten
		// by those coming from command line
		Object.keys(jsonConfig).forEach(function(key) {
			if (typeof params[key] === 'undefined') {
				params[key] = jsonConfig[key];
			}
		});
	}

	// parse script CLI parameters
	this.params = params;

	// --url=http://example.com
	this.url = this.params.url;

	// --format=[csv|json]
	this.format = params.format || 'plain';

	// --verbose
	this.verboseMode = params.verbose === true;

	// --silent
	this.silentMode = params.silent === true;

	// --timeout (in seconds)
	this.timeout = (params.timeout > 0 && parseInt(params.timeout, 10)) || 15;

	// --modules=localStorage,cookies
	this.modules = (typeof params.modules === 'string') ? params.modules.split(',') : [];

	// --include-dirs=dirOne,dirTwo
	this.includeDirs = (typeof params['include-dirs'] === 'string') ? params['include-dirs'].split(',') : [];

	// --skip-modules=jQuery,domQueries
	this.skipModules = (typeof params['skip-modules'] === 'string') ? params['skip-modules'].split(',') : [];

	// disable JavaScript on the page that will be loaded
	this.disableJs = params['disable-js'] === true;

	// setup cookies handling
	this.initCookies();

	// setup the stuff
	this.emitter = new (this.require('events').EventEmitter)();
	this.emitter.setMaxListeners(200);

	this.util = this.require('util');

	this.page = require('webpage').create();

	// store the timestamp of responseEnd event
	// should be bound before modules
	this.on('responseEnd', this.proxy(function() {
		this.responseEndTime = Date.now();
	}));

	// setup logger
	var Logger = require('./logger'),
		logFile = params.log || '';

	this.logger = new Logger(logFile, {
		beVerbose: this.verboseMode,
		beSilent: this.silentMode
	});

	// report version and installation directory
	if (typeof module.dirname !== 'undefined') {
		this.dir = module.dirname.replace(/core$/, '');
		this.log('phantomas v' + this.getVersion() + ' installed in ' + this.dir);
	}

	// report config file being used
	if (params.config) {
		this.log('Using JSON config file: ' + params.config);
	}
	else if (params.config === false) {
		this.log('Failed parsing JSON config file');
		this.tearDown(EXIT_CONFIG_FAILED);
		return;
	}

	// queue of jobs that needs to be done before report can be generated
	var Queue = require('../lib/simple-queue');
	this.reportQueue = new Queue();

	// set up results wrapper
	var Results = require('./results');
	this.results = new Results();

	this.results.setGenerator('phantomas v' + this.getVersion());
	this.results.setUrl(this.url);
	this.results.setAsserts(this.params.asserts);

	// allow asserts to be provided via command-line options (#128)
	Object.keys(this.params).forEach(function(param) {
		var value = parseFloat(this.params[param]),
			name;

		if (!isNaN(value) && param.indexOf('assert-') === 0) {
			name = param.substr(7);

			if (name.length > 0) {
				this.results.setAssert(name, value);
			}
		}
	}, this);

	// load core modules
	this.log('Loading core modules...');
	this.addCoreModule('requestsMonitor');
	this.addCoreModule('httpAuth');

	// load 3rd party modules
	var modules = (this.modules.length > 0) ? this.modules : this.listModules();

	modules.forEach(this.addModule, this);

	this.includeDirs.forEach(function(dirName) {
		var fs = require('fs'),
			dirPath = fs.absolute(dirName),
			dirModules = this.listModulesInDir(dirPath);

		dirModules.forEach(function(moduleName) {
			this.addModuleInDir(dirPath, moduleName);
		}, this);

	}, this);
};

phantomas.version = VERSION;

phantomas.prototype = {
	// simple version of jQuery.proxy
	proxy: function(fn, scope) {
		scope = scope || this;
		return function () {
			return fn.apply(scope, arguments);
		};
	},

	// emit given event
	emit: function(/* eventName, arg1, arg2, ... */) {
		this.log('Event ' + arguments[0] + ' emitted');
		this.emitter.emit.apply(this.emitter, arguments);
	},

	// bind to a given event
	on: function(ev, fn) {
		this.emitter.on(ev, fn);
	},

	once: function(ev, fn) {
		this.emitter.once(ev, fn);
	},

	getVersion: function() {
		return VERSION;
	},

	getParam: function(key, defValue, typeCheck) {
		var value = this.params[key];

		// strict type check
		if (typeof typeCheck === 'string' && typeof value !== typeCheck) {
			value = undefined;
		}

		return value || defValue;
	},

	// returns "wrapped" version of phantomas object with public methods / fields only
	getPublicWrapper: function() {
		function setParam(key, value) {
			/* jshint validthis: true */
			this.log('setParam: %s set to %j', key, value);
			this.params[key] = value;
		}

		function setZoom(zoomFactor) {
			/* jshint validthis: true */
			this.page.zoomFactor = zoomFactor;
		}

		// modules API
		return {
			url: this.params.url,
			getVersion: this.getVersion.bind(this),
			getParam: this.getParam.bind(this),
			setParam: setParam.bind(this),

			// events
			on: this.on.bind(this),
			once: this.once.bind(this),
			emit: this.emit.bind(this),

			// reports
			reportQueuePush: this.reportQueue.push.bind(this.reportQueue),

			// metrics
			setMetric: this.setMetric.bind(this),
			setMetricEvaluate: this.setMetricEvaluate.bind(this),
			setMetricFromScope: this.setMetricFromScope.bind(this),
			setMarkerMetric: this.setMarkerMetric.bind(this),
			getFromScope: this.getFromScope.bind(this),
			incrMetric: this.incrMetric.bind(this),
			getMetric: this.getMetric.bind(this),

			// offenders
			addOffender: this.addOffender.bind(this),

			// debug
			log: this.log.bind(this),
			echo: this.echo.bind(this),

			// phantomJS
			evaluate: this.page.evaluate.bind(this.page),
			injectJs: this.page.injectJs.bind(this.page),
			require: this.require.bind(this),
			render: this.page.render.bind(this.page),
			setZoom: setZoom.bind(this),
			getSource: this.getSource.bind(this),

			// utils
			runScript: this.runScript.bind(this)
		};
	},

	// initialize given core phantomas module
	addCoreModule: function(name) {
		var pkg = require('./modules/' + name + '/' + name);

		// init a module
		pkg.module(this.getPublicWrapper());

		this.log('Core module ' + name + (pkg.version ? ' v' + pkg.version : '') + ' initialized');
	},

	// initialize given phantomas module
	addModule: function(name) {
		return this.addModuleInDir('./../modules', name);
	},

	// initialize given phantomas module from dir
	addModuleInDir: function(dir, name) {
		var pkg;
		if (this.skipModules.indexOf(name) > -1) {
			this.log('Module ' + name + ' skipped!');
			return;
		}
		try {
			pkg = require(dir + '/' + name + '/' + name);
		}
		catch (e) {
			this.log('Unable to load module "' + name + '" from ' + dir + '!');
			return false;
		}

		if (pkg.skip) {
			this.log('Module ' + name + ' skipped!');
			return false;
		}

		// init a module
		pkg.module(this.getPublicWrapper());

		this.log('Module ' + name + (pkg.version ? ' v' + pkg.version : '') + ' initialized');
		return true;
	},

	// returns list of 3rd party modules located in modules directory
	listModules: function() {
		return this.listModulesInDir(module.dirname + '/../modules');
	},

	// returns list of 3rd party modules located in modules directory
	listModulesInDir: function(modulesDir) {
		this.log('Getting the list of all modules in %s...', modulesDir);

		var fs = require('fs'),
			ls = fs.list(modulesDir) || [],
			modules = [];

		ls.forEach(function(entry) {
			if (fs.isFile(modulesDir + '/' + entry + '/' + entry + '.js')) {
				modules.push(entry);
			}
		});

		return modules;
	},

	// setup cookies handling
	initCookies: function() {
		// cookie handling via command line and config.json
		phantom.cookiesEnabled = true;

		// handles multiple cookies from config.json, and used for storing
		// constructed cookies from command line.
		this.cookies = this.params.cookies || [];

		// --cookie='bar=foo;domain=url'
		// for multiple cookies, please use config.json `cookies`.
		if (typeof this.params.cookie === 'string') {

			// Parse cookie. at minimum, need a key=value pair, and a domain.
			// Domain attr, if unavailble, is created from `params.url` during
			//  addition to phantomjs in `phantomas.run`
			// Full JS cookie syntax is supported.

			var cookieComponents = this.params.cookie.split(';'),
				cookie = {};

			for (var i = 0, len = cookieComponents.length; i < len; i++) {
				var frag = cookieComponents[i].split('=');

				// special case: key-value
				if (i === 0) {
					cookie.name = frag[0];
					cookie.value = frag[1];

				// special case: secure
				} else if (frag[0] === 'secure') {
					cookie.secure = true;

				// everything else
				} else {
					cookie[frag[0]] = frag[1];
				}
			}

			// see phantomas.run for validation.
			this.cookies.push(cookie);
		}
	},

	// add cookies, if any, providing a domain shim
	injectCookies: function() {
		if (this.cookies && this.cookies.length > 0) {
			// @see http://nodejs.org/docs/latest/api/url.html
			var parseUrl = this.require('url').parse;

			this.cookies.forEach(function(cookie) {

				// phantomjs required attrs: *name, *value, *domain
				if (!cookie.name || !cookie.value) {
					throw 'this cookie is missing a name or value property: ' + JSON.stringify(cookie);
				}

				if (!cookie.domain) {
					var parsed = parseUrl(this.params.url),
						root = parsed.hostname.replace(/^www/, ''); // strip www

					cookie.domain = root;
				}

				if (!phantom.addCookie(cookie)) {
					throw 'PhantomJS could not add cookie: ' + JSON.stringify(cookie);
				}

				this.log('Cookie set: ' + JSON.stringify(cookie));

			}, this /* scope */);
		}
	},

	// setup polling for loading progress (issue #204)
	// pipe JSON messages over stderr
	initLoadingProgress: function() {
		var currentProgress = false,
			ipc = new (require('./ipc'))('progress');

		function pollFn() {
			/* jshint validthis: true */
			var inc;

			if (currentProgress >= this.page.loadingProgress) {
				return;
			}

			// store the change and update the current progress
			inc = this.page.loadingProgress - currentProgress;
			currentProgress = this.page.loadingProgress;

			this.log('Loading progress: %d%', currentProgress);

			this.emit('progress', currentProgress, inc); // @desc loading progress has changed
			ipc.push(currentProgress, inc);
		}

		setInterval(pollFn.bind(this), 100);
	},

	// runs phantomas
	run: function() {
		// check required params
		if (!this.url) {
			throw '--url argument must be provided!';
		}

		// add cookies, if any, providing a domain shim.
		this.injectCookies();

		this.start = Date.now();

		// setup viewport / --viewport=1280x1024
		var parsedViewport = this.getParam('viewport', '1280x1024', 'string').split('x');

		if (parsedViewport.length === 2) {
			this.page.viewportSize = {
				width: parseInt(parsedViewport[0], 10) || 1280,
				height: parseInt(parsedViewport[1], 10) || 1024
			};
		}

		// setup user agent /  --user-agent=custom-agent
		this.page.settings.userAgent = this.getParam('user-agent', getDefaultUserAgent(), 'string');

		// disable JavaScript on the page that will be loaded
		if (this.disableJs) {
			this.page.settings.javascriptEnabled = false;
			this.log('JavaScript execution disabled by --disable-js!');
		}

		// print out debug messages
		this.log('Opening <%s>...', this.url);
		this.log('Using %s as user agent', this.page.settings.userAgent);
		this.log('Viewport set to %d x %d', this.page.viewportSize.width, this.page.viewportSize.height);

		// bind basic events
		this.page.onInitialized = this.proxy(this.onInitialized);
		this.page.onLoadStarted = this.proxy(this.onLoadStarted);
		this.page.onLoadFinished = this.proxy(this.onLoadFinished);
		this.page.onResourceRequested = this.proxy(this.onResourceRequested);
		this.page.onResourceReceived = this.proxy(this.onResourceReceived);

		// debug
		this.page.onAlert = this.proxy(this.onAlert);
		this.page.onConfirm = this.proxy(this.onConfirm);
		this.page.onPrompt = this.proxy(this.onPrompt);
		this.page.onConsoleMessage = this.proxy(this.onConsoleMessage);
		this.page.onCallback = this.proxy(this.onCallback);
		this.page.onError = this.proxy(this.onError);

		this.initLoadingProgress();

		// observe HTTP requests
		// finish when the last request is completed + one second timeout
		var self = this;

		this.reportQueue.push(function(done) {
			var currentRequests = 0,
				requestsUrls = {},
				onFinished = function(entry) {
					currentRequests--;
					delete requestsUrls[entry.url];

					if (currentRequests < 1) {
						timeoutId = setTimeout(function() {
							done();
						}, 1000);
					}
				},
				timeoutId;

			// update HTTP requests counter
			self.on('send', function(entry) {
				clearTimeout(timeoutId);

				currentRequests++;
				requestsUrls[entry.url] = true;
			});

			self.on('recv', onFinished);
			self.on('abort', onFinished);

			// add debug info about pending responses (issue #216)
			self.on('timeout', function() {
				self.log('Timeout: gave up waiting for %d HTTP response(s): <%s>', currentRequests, Object.keys(requestsUrls).join('>, <'));
			});
		});

		this.reportQueue.push(function(done) {
			self.on('loadFinished', done);
		});

		// generate a report when all jobs are done
		this.reportQueue.done(this.report, this);

		// last time changes?
		this.emit('pageBeforeOpen', this.page); // @desc page.open is about to be called

		// open the page
		this.page.open(this.url);

		this.emit('pageOpen'); // @desc page.open has been called

		// fallback - always timeout after TIMEOUT seconds
		this.log('Timeout set to %d sec', this.timeout);
		setTimeout(function() {
			this.log('Timeout of %d sec was reached!', this.timeout);

			this.emit('timeout'); // @desc phantomas has timed out
			this.timedOut = true;

			this.report();
		}.bind(this), this.timeout * 1000);
	},

	// called when all HTTP requests are completed
	report: function() {
		this.emit('report'); // @desc the report is about to be generated

		var time = Date.now() - this.start;
		this.log('phantomas run for <%s> completed in %d ms', this.page.url, time);

		this.results.setUrl(this.page.url);
		this.emit('results', this.results); // @desc modify the results

		// count all metrics
		var metricsCount = this.results.getMetricsNames().length;

		this.log('Returning results with ' + metricsCount+ ' metric(s)...');

		// emit results in JSON
		var formatter = require('./formatter'),
			stdout = require('system').stdout;

		stdout.write(formatter(this.results));

		// handle timeouts (issue #129)
		if (this.timedOut) {
			this.log('Timed out!');
			this.tearDown(EXIT_TIMED_OUT);
			return;
		}

		// asserts handling
		var failedAsserts = this.results.getFailedAsserts(),
			failedAssertsCnt = failedAsserts.length;

		if (failedAssertsCnt > 0) {
			this.log('Failed on %d assert(s) on the following metric(s): %s!', failedAssertsCnt, failedAsserts.join(', '));

			// exit code should equal number of failed assertions
			this.tearDown(failedAssertsCnt);
			return;
		}

		this.log('Done!');
		this.tearDown();
	},

	tearDown: function(exitCode) {
		exitCode = exitCode || EXIT_SUCCESS;

		if (exitCode > 0) {
			this.log('Exiting with code #' + exitCode + '!');
		}

		this.page.close();
		phantom.exit(exitCode);
	},

	// core events
	onInitialized: function() {
		// add helper tools into window.__phantomas "namespace"
		if (!this.page.injectJs(module.dirname + '/scope.js')) {
			this.log('Unable to inject scope.js file!');
			this.tearDown(EXIT_ERROR);
			return;
		}

		this.log('Page object initialized');
		this.emit('init'); // @desc page has been initialized, scripts can be injected
	},

	onLoadStarted: function() {
		this.log('Page loading started');
		this.emit('loadStarted'); // @desc page loading has started
	},

	onResourceRequested: function(res, request /* added in PhantomJS v1.9 */) {
		this.emit('onResourceRequested', res, request); // @desc HTTP request has been sent
		//this.log(JSON.stringify(res));
	},

	onResourceReceived: function(res) {
		this.emit('onResourceReceived', res); // @desc HTTP response has been received
		//this.log(JSON.stringify(res));
	},

	onLoadFinished: function(status) {
		// trigger this only once
		if (this.onLoadFinishedEmitted) {
			return;
		}
		this.onLoadFinishedEmitted = true;

		// we're done
		this.log('Page loading finished ("' + status + '")');

		switch(status) {
			case 'success':
				this.emit('loadFinished', status); // @desc page has been fully loaded
				break;

			default:
				this.emit('loadFailed', status); // @desc page loading failed
				this.tearDown(EXIT_LOAD_FAILED);
				break;
		}
	},

	// debug
	onAlert: function(msg) {
		this.log('Alert: ' + msg);
		this.emit('alert', msg); // @desc the page called window.alert
	},

	onConfirm: function(msg) {
		this.log('Confirm: ' + msg);
		this.emit('confirm', msg); // @desc the page called window.confirm
	},

	onPrompt: function(msg) {
		this.log('Prompt: ' + msg);
		this.emit('prompt', msg); // @desc the page called window.prompt
	},

	onConsoleMessage: function(msg) {
		var prefix, data;

		// split "foo:content"
		prefix = msg.substr(0,3);
		data = msg.substr(4);

		try {
			data = JSON.parse(data);
		}
		catch(ex) {
			// fallback to plain log
			prefix = false;
		}

		//console.log(JSON.stringify([prefix, data]));

		switch(prefix) {
			// handle JSON-encoded messages from browser's scope sendMsg()
			case 'msg':
				this.onCallback(data);
				break;

			// console.log arguments are passed as JSON-encoded array
			case 'log':
				msg = this.util.format.apply(this, data);

				this.log('console.log: ' + msg);
				this.emit('consoleLog', msg, data); // @desc the page called console.log
				break;

			default:
				this.log(msg);
		}
	},

	// https://github.com/ariya/phantomjs/wiki/API-Reference-WebPage#oncallback
	onCallback: function(msg) {
		var type = msg && msg.type || '',
			data = msg && msg.data || {};

		switch(type) {
			case 'log':
				this.log(data);
				break;

			case 'setMetric':
				this.setMetric(data.name, data.value, data.isFinal);
				break;

			case 'incrMetric':
				this.incrMetric(data.name, data.incr);
				break;

			case 'setMarkerMetric':
				this.setMarkerMetric(data.name);
				break;

			case 'addOffender':
				this.addOffender(data.metricName, data.msg);
				break;

			default:
				this.log('Message "' + type + '" from browser\'s scope: ' + JSON.stringify(data));
				this.emit('message', msg); // @desc the scope script sent a message
		}
	},

	onError: function(msg, trace) {
		this.emit('jserror', msg, trace); // @desc JS error occured
	},

	// metrics reporting
	setMetric: function(name, value, isFinal) {
		var ipc = new (require('./ipc'))('metric');

		value = typeof value === 'string' ? value : (value || 0); // set to zero if undefined / null is provided
		this.results.setMetric(name, value);

		// trigger an event when the metric value is said to be final (isse #240)
		if (isFinal === true) {
			this.emit('metric', name, value); // @desc the metric is given the final value
			ipc.push(name, value);
		}
	},

	setMetricEvaluate: function(name, fn) {
		this.setMetric(name, this.page.evaluate(fn), true /* isFinal */);
	},

	setMarkerMetric: function(name) {
		var now = Date.now(),
			value = now - this.responseEndTime;

		if (typeof this.responseEndTime === 'undefined') {
			throw 'setMarkerMetric() called before responseEnd event!';
		}

		this.setMetric(name, value, true /* isFinal */);
		return value;
	},

	// set metric from browser's scope that was set there using using window.__phantomas.set()
	setMetricFromScope: function(name, key) {
		key = key || name;

		// @ee https://github.com/ariya/phantomjs/wiki/API-Reference-WebPage#evaluatefunction-arg1-arg2--object
		this.setMetric(name, this.page.evaluate(function(key) {
			return window.__phantomas.get(key) || 0;
		}, key), true /* isFinal */);
	},

	// get a value set using window.__phantomas browser scope
	getFromScope: function(key) {
		return this.page.evaluate(function(key) {
			return window.__phantomas.get(key);
		}, key);
	},

	// increements given metric by given number (default is one)
	incrMetric: function(name, incr /* =1 */) {
		var currVal = this.getMetric(name) || 0;

		this.setMetric(name, currVal + (incr || 1));
	},

	getMetric: function(name) {
		return this.results.getMetric(name);
	},

	getSource: function () {
		return this.page.content;
	},

	addOffender: function(/**metricName, msg, ... */) {
		var args = Array.prototype.slice.call(arguments),
			metricName = args.shift();

		this.results.addOffender(metricName, this.util.format.apply(this, args));
	},

	// add log message
	// will be printed out only when --verbose
	// supports phantomas.log('foo: <%s>', url);
	log: function() {
		this.logger.log(this.util.format.apply(this, arguments));
	},

	// console.log wrapper obeying --silent mode
	echo: function(msg) {
		this.logger.echo(msg);
	},

	// require CommonJS module from lib/modules
	require: function(module) {
		return require('../lib/modules/' + module);
	},

	// runs a given helper script from phantomas main directory
	// tries to parse it's output (assumes JSON formatted output)
	runScript: function(script, args, callback) {
		var execFile = require("child_process").execFile,
			start = Date.now(),
			self = this,
			pid,
			ctx;

		if (typeof args === 'function') {
			callback = args;
		}

		// execFile(file, args, options, callback)
		// @see https://github.com/ariya/phantomjs/wiki/API-Reference-ChildProcess
		args = args || [];
		script = this.dir + script;

		ctx = execFile(script, args, null, function (err, stdout, stderr) {
			var time = Date.now() - start;

			if (err || stderr) {
				self.log('runScript: pid #%d failed - %s (took %d ms)!', pid, (err || stderr || 'unknown error').trim(), time);
			}
			else if (!pid) {
				self.log('runScript: failed running %s %s!', script, args.join(' '));
				return;
			}
			else {
				self.log('runScript: pid #%d done (took %d ms)', pid, time);
			}

			// (try to) parse JSON-encoded output
			try {
				callback(null, JSON.parse(stdout));
			}
			catch(ex) {
				self.log('runScript: JSON parsing failed!');
				callback(stderr, stdout);
			}
		});

		pid = ctx.pid;

		if (pid) {
			this.log('runScript: %s %s (pid #%d)', script, args.join(' '), pid);
		}
	}
};

module.exports = phantomas;
