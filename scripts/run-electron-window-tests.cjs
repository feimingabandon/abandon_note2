const { main, reportError, windowGroups } = require('./run-test-entry.cjs')

if (require.main === module) main('window', process.argv.slice(2)).catch(reportError)

module.exports = { groups: windowGroups, main: (argv, options) => main('window', argv, options) }
