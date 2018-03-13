'use strict';

let child_process = require('child_process');
let Deque = require('double-ended-queue');

/* global JuttleAdapterAPI */
let AdapterRead = JuttleAdapterAPI.AdapterRead;
let parsers = JuttleAdapterAPI.parsers;
let JuttleMoment = JuttleAdapterAPI.types.JuttleMoment;
let errors = JuttleAdapterAPI.errors;
let _ = require('underscore');
let byline = require('byline');

class Read_Sysdig extends AdapterRead {
    periodicLiveRead() { return true;}

    defaultTimeOptions() {
        return {
            from: this.params.now,
            to: new JuttleMoment(Infinity),
	    lag: JuttleMoment.duration(5, 's')
        };
    }

    static allowedOptions() {
        return AdapterRead.commonOptions().concat(['raw', 'fmt']);
    }
    
    constructor(options, params) {
        super(options, params);
        this.logger.info('initializing read Sysdig');

	this._queue = new Deque(1024*1024);

	this.warnLate = this.throttledWarning('POINTS-ARRIVED-LATE', {
            proc: 'read sysdig'
        });

	let sysdig_cmd = ['-j'];
	if (options.fmt) {
	    sysdig_cmd = sysdig_cmd.concat(['-p', options.fmt]);
	}
	if (options.container) {
	    sysdig_cmd = sysdig_cmd.concat(['-pc']);
	}
	if (options.raw) {
	    sysdig_cmd = sysdig_cmd.concat([options.raw]);
	};

	this.logger.debug("Sysdig commandline:", sysdig_cmd);
	this._sysdig_process = child_process.spawn('sysdig', sysdig_cmd);

	this._sysdig_process.stderr.on('data', (data) => {
            this.trigger('error', new errors.runtimeError('INTERNAL-ERROR', {
                error: data.toString()
            }));
	});

	this._sysdig_process.on('close', (code) => {
	    console.error("Exited with code", code);
	});
	    
	this.parser = parsers.getParser('json', options);

        this.parser.on('error', (err) => {
            this.trigger('error', new errors.runtimeError('INTERNAL-ERROR', {
                error: err.toString()
            }));
        });

	let stream = this._sysdig_process.stdout.pipe(byline());

	stream.on('data', (line) => {
	    line = line.toString();
	    // Remove any leading [] or any trailing ,
	    if (line.startsWith('[') ||
		line.startsWith(']')) {
		line = line.substr(1);
	    }
	    if (line.endsWith(',') ||
		line.endsWith(']')) {
		line = line.slice(0, -1);
	    }
	    if (line == "") {
		return;
	    }
	    let data = JSON.parse(line.toString());
	    let point = {};

	    // Look for a few fields for the time
	    let rawtime = data['evt.time'];
	    if (! rawtime) {
		rawtime = data['evt.outputtime'];
	    }
	    
	    let time = new JuttleMoment({rawDate: new Date(Number(Math.floor(rawtime / 1000000)))});
	    point.time = time;
	    // Convert all dots in properties to dashes
	    _.map(data, (val, key) => {
		let newkey = key.replace(/\./g, '-');
		point[newkey] = val;
	    });
	    this._queue.push(point);	    
	});
	
        // this.parser.parseStream(stream, (points) => {
        //     this.logger.debug('parsed', points.length, 'points');
	//     for(let point of points) {
	// 	let newpoint = {};
	// 	let time = new JuttleMoment({rawDate: new Date(Number(Math.floor(point['evt.time'] / 1000000)))});
	// 	newpoint.time = time;
	// 	// Convert all dots in properties to dashes
	// 	_.map(point, (val, key) => {
	// 	    let newkey = key.replace(/\./g, '-');
	// 	    newpoint[newkey] = val;
	// 	});
	// 	this._queue.push(newpoint);
	//     }
        // });
    }

    read(from, to, limit, state) {

	this.logger.debug(`${this._queue.length} items in queue`);
	let points = [];
	let points_dropped = 0;
	while(! this._queue.isEmpty()) {
	    let pt = this._queue.peekFront();
	    if (pt.time >= to) {
		break;
	    }
	    pt = this._queue.shift();
	    if (pt.time < from) {
		points_dropped++;
	    } else {
		points.push(pt);
	    }
	}

	if (points_dropped > 0) {
	    this.warnLate();
	}

	this.logger.debug(`${points.length} points returned`);
	
	return Promise.resolve({points: points, readEnd: to});
    }

    teardown() {
	this.logger.info('In teardown()');
	this._sysdig_process.kill();
    }
}

module.exports = Read_Sysdig;
