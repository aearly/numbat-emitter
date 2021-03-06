/*global describe:true, it:true, before:true, after:true, beforeEach: true, afterEach:true */
'use strict';

const
	demand     = require('must'),
	stream     = require('readable-stream'),
	dgram      = require('dgram'),
	net        = require('net'),
	Emitter    = require('../index'),
	JSONStream = require('json-stream')
	;

describe('metric()', function()
{
	const mockOpts = {
		uri: 'tcp://localhost:4333',
		app: 'testapp',
		node: 'node-1'
	};

	const mockUDPOpts = {
		uri: 'udp://localhost:4334',
		app: 'testapp',
	};

	const mockStatsdOpts = {
		uri: 'statsd://localhost:4335',
		app: 'statsdapp',
	};

	let mockServer, mockUDPServer, mockStatsdServer;

	before(function(done)
	{
		let count = 0;
		function onConnection(socket)
		{
			const instream = new JSONStream();
			socket.pipe(instream);
			instream.on('data', function(data)
			{
				mockServer.emit('received', data);
			});
		}

		mockServer = net.createServer(onConnection);
		mockServer.listen(4333, function()
		{
			count++;
			if (count === 2) done();
		});

		mockUDPServer = dgram.createSocket('udp4');
		mockUDPServer.on('listening', function()
		{
			count++;
			if (count === 2) done();
		});
		mockUDPServer.on('message', function(msg, rinfo)
		{
			mockUDPServer.emit('received', JSON.parse(msg));
		});
		mockUDPServer.bind(4334);
	});

	before(function(done)
	{
		mockStatsdServer = dgram.createSocket('udp4');
		mockStatsdServer.on('listening', done);
		mockStatsdServer.on('message', function(msg, rinfo)
		{
			mockStatsdServer.emit('received', msg);
		});
		mockStatsdServer.bind(4335);
	});

	describe('via metric()', function()
	{
		it('makeEvent() returns nothing for an empty metric', function()
		{
			const emitter = new Emitter(mockOpts);
			const m = emitter.makeEvent();
			demand(m).be.undefined();
		});

		it('requires a `name` field for all metrics', function()
		{
			const emitter = new Emitter(mockOpts);
			const m = emitter.makeEvent({ foo: 'bar' });
			demand(m).be.undefined();
		});

		it('supplies a value of 1 if one is not provided', function(done)
		{
			function observer(d)
			{
				d.must.be.an.object();
				d.must.have.property('value');
				d.value.must.equal(1);
				mockServer.removeListener('received', observer);
				done();
			}

			mockServer.on('received', observer);
			const emitter = new Emitter(mockOpts);
			emitter.metric({ name: 'test' });
		});

		it('can emit statsd counts', function(done)
		{
			function observer(d)
			{
				d.must.startWith('statsdapp.test:1|c');
				done();
			}

			mockStatsdServer.once('received', observer);
			const emitter = new Emitter(mockStatsdOpts);
			emitter.metric({ name: 'test' });
		});

		it('can emit statsd gauges', function(done)
		{
			function observer(d)
			{
				d.must.startWith('statsdapp.test-gauge:42|g');
				done();
			}

			mockStatsdServer.once('received', observer);
			const emitter = new Emitter(mockStatsdOpts);
			emitter.metric({ name: 'test-gauge', value: 42 });
		});

		it('returns the metric it makes for your curiosity', function()
		{
			const emitter = new Emitter(mockUDPOpts);
			const obj = emitter.metric({ name: 'returnme' });
			obj.must.be.an.object();
			obj.name.must.equal('testapp.returnme');
			obj.must.have.property('host');
			obj.must.not.have.property('node');
		});

		it('writes event objects to its socket', function(done)
		{
			function observer(d)
			{
				d.must.be.an.object();
				d.must.have.property('host');
				d.must.have.property('time');
				d.must.have.property('node');
				d.node.must.equal('node-1');
				d.value.must.equal(4);
				d.name.must.equal('testapp.test');
				mockServer.removeListener('received', observer);
				done();
			}

			mockServer.on('received', observer);
			const emitter = new Emitter(mockOpts);
			emitter.metric({ name: 'test', value: 4 });
		});

		it('does not override the time field when present', function(done)
		{
			function observer(d)
			{
				d.must.be.an.object();
				d.must.have.property('time');
				d.time.toString().must.equal('2014-01-01T00:00:00.000Z');
				mockServer.removeListener('received', observer);
				done();
			}

			mockServer.on('received', observer);
			const emitter = new Emitter(mockOpts);
			emitter.metric({ name: 'test', value: 4, time: new Date('2014-01-01') });
		});

		it('events are preserved until reconnected', function(done)
		{
			this.timeout(5000);

			const emitter = new Emitter(mockOpts);
			emitter.on('close', function()
			{
				emitter.metric({ name: 'test.splort', value: 4 });
				emitter.metric({ name: 'test.latency', value: 30 });
				const ws = new stream.Writable();
				const acc = [];
				ws._write = function(chunk, enc, cb)
				{
					acc.push(chunk);
					cb();
				};
				ws.once('finish', function()
				{
					const items = Buffer.concat(acc)
						.toString('utf8')
						.split('\n')
						.slice(0, -1)
						.map(JSON.parse);
					items.must.be.an.array();
					items.length.must.equal(2);
					items[0].must.have.property('name');
					items[0].name.must.equal('testapp.test.splort');
					done();
				});
				emitter.output.pipe(ws);
				emitter.input.end();
			});

			emitter.connect = function() {};
			emitter.client.end();
		});
	});

	describe('via process.emit("metric")', function()
	{
		it('calls metric() on global emitter', function(done)
		{
			const emitter = new Emitter(mockUDPOpts);
			Emitter.setGlobalEmitter(emitter);

			const expect = {name: 'example'};
			let seen = null;
			emitter.metric = function(xs)
			{
				seen = xs;
			};
			process.emit('metric', expect);
			demand(seen).equal(expect);
			done();
		});

		it('skips destroyed emitters', function(done)
		{

			const expect = {name: 'example'};
			const emitter = new Emitter(mockUDPOpts);
			Emitter.setGlobalEmitter(emitter);

			emitter.metric = function()
			{
				throw new Error('should not reach this point');
			};
			emitter.destroy();
			process.emit('metric', expect);
			done();
		});

		it('skips closed emitters', function(done)
		{
			const emitter = new Emitter(mockOpts);
			emitter.maxretries = 0;
			const expect = {name: 'example'};
			Emitter.setGlobalEmitter(emitter);
			emitter.metric = function()
			{
				throw new Error('should not reach this point');
			};
			emitter.connect();
			emitter.on('ready', function()
			{
				emitter.client.destroy();
				emitter.on('close', function()
				{
					process.emit('metric', expect);
					done();
				});
			});
		});
	});

	after(function(done)
	{
		mockServer.close();
		mockUDPServer.close();
		mockStatsdServer.close();
		done();
	});
});
