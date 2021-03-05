const path = require("path");
const dirname = path.dirname;
const loaderUtils = require("loader-utils");
const nodeResolve = require("resolve").sync;
const walk = require('pug-walk');

module.exports = function(source) {
	this.cacheable && this.cacheable();

	const modulePaths = {};
	modulePaths.pug = require.resolve("pug");
	modulePaths.load = nodeResolve("pug-load", {basedir: dirname(modulePaths.pug)});
	modulePaths.runtime = nodeResolve("pug-runtime", {basedir: dirname(modulePaths.pug)});

	const pug = require(modulePaths.pug);
	const load = require(modulePaths.load);

	const req = loaderUtils.getRemainingRequest(this).replace(/^!/, "");

	const query = loaderUtils.getOptions(this) || {};

	const loadModule = this.loadModule;
	const resolve = this.resolve;
	const loaderContext = this;
	let callback;

	const fileContents = {};
	const filePaths = {};

	let missingFileMode = false;
	function getFileContent(context, request) {
		request = loaderUtils.urlToRequest(request, query.root)
		const baseRequest = request;
		let filePath;

		filePath = filePaths[context + " " + request];
		if(filePath) return filePath;

		let isSync = true;
		resolve(context, request, function(err, _request) {
			if(err) {
				resolve(context, request, function(err2, _request) {
					if(err2) return callback(err2);

					request = _request;
					next();
				});
				return;
			}

			request = _request;
			next();
			function next() {
				loadModule("-!" + path.join(__dirname, "stringify.loader.js") + "!" + request, function(err, source) {
					if(err) return callback(err);

					filePaths[context + " " + baseRequest] = request;
					fileContents[request] = JSON.parse(source);

					if(!isSync) {
						run();
					}
				});
			}
		});

		filePath = filePaths[context + " " + baseRequest];
		if(filePath) return filePath;

		isSync = false;
		missingFileMode = true;
		throw "continue";
	}

	const plugin = loadModule ? {
		postParse: function (ast) {
			return walk(ast, function (node) {
				if ([
					"Mixin",
					"MixinBlock",
					"NamedBlock"
				].indexOf(node.type) !== -1) {
					ast._mustBeInlined = true;
				}
			});
		},
		resolve: function (request, source) {
			if (!callback) {
				callback = loaderContext.async();
			}

			if (!callback) {
				return load.resolve(request, source);
			}

			const context = dirname(source.split("!").pop());
			return getFileContent(context, request);
		},
		read: function (path) {
			if (!callback) {
				return load.read(path);
			}

			return fileContents[path];
		},
		postLoad: function postLoad(ast) {
			return walk(ast, function (node) {
				if (node.file && node.file.ast) {
					postLoad(node.file.ast);
				}

				if (node.type === "Include") {
					if (node.file.ast._mustBeInlined) {
						ast._mustBeInlined = true;
					}
				}
			}, function (node, replace) {
				if (node.type === "Include" && !(node.block && node.block.nodes.length) && !node.file.ast._mustBeInlined) {
					replace({
						type: "Code",
						val: "require(" + loaderUtils.stringifyRequest(loaderContext, node.file.fullPath) + ").call(this, locals)",
						buffer: true,
						mustEscape: false,
						isInline: false,
						line: node.line,
						filename: node.filename
					});
				}
			});
		}
	} : {};

	run();
	function run() {
		let tmplFunc;
		try {
			tmplFunc = pug.compileClient(source, {
				filename: req,
				doctype: query.doctype || "html",
				pretty: query.pretty,
				self: query.self,
				compileDebug: loaderContext.debug || false,
				globals: ["require"].concat(query.globals || []),
				name: "template",
				inlineRuntimeFunctions: false,
				filters: query.filters,
				plugins: [
					plugin
				].concat(query.plugins || [])
			});
		} catch(e) {
			if(missingFileMode) {
				// Ignore, it'll continue after async action
				missingFileMode = false;
				return;
			}
			loaderContext.callback(e);
			return;
		}
		const runtime = "var pug = require(" + loaderUtils.stringifyRequest(loaderContext, "!" + modulePaths.runtime) + ");\n\n";
		loaderContext.callback(null, runtime + tmplFunc.toString() + ";\nmodule.exports = template;");
	}
}
