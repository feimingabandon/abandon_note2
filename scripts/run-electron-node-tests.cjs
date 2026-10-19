const { main, reportError } = require('./run-test-entry.cjs')

if (require.main === module) main('database', process.argv.slice(2)).catch(reportError)

module.exports = { main: (argv, options) => main('database', argv, options) }
