async function main() {
  return require('./run-focused-tests.cjs').main([
    '--file',
    'tests/attachment-storage-electron.mjs'
  ])
}

module.exports = { main }

if (require.main === module)
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
