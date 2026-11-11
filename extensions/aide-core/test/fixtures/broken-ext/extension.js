// Deliberately broken extension used to verify that one failing extension does not break AIDE.
exports.activate = function () {
	throw new Error('broken-ext: activation failure (expected in tests)');
};
