const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')
const compiler = require('@vue/compiler-sfc')

exports.prepareUiFixture = async function (out, fixture = 'ui-components.vue') {
  let index = 0
  const root = path.resolve(__dirname, '../..')
  const result = await esbuild.build({
    stdin: {
      contents: `import {createApp} from 'vue'; import Fixture from './tests/fixtures/${fixture}'; createApp(Fixture).mount('#app');`,
      resolveDir: root
    },
    alias: { '@': root },
    loader: { '.svg': 'dataurl' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    define: {
      'process.env.NODE_ENV': '"production"',
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false'
    },
    plugins: [
      {
        name: 'ui-fixture',
        setup(build) {
          build.onLoad({ filter: /\.vue$/ }, (args) => {
            const { descriptor } = compiler.parse(fs.readFileSync(args.path, 'utf8'), {
              filename: args.path
            })
            const id = 'data-v-ui-' + ++index
            const code = compiler.compileScript(descriptor, {
              id,
              inlineTemplate: true,
              genDefaultAs: '__sfc__',
              templateOptions: { compilerOptions: { scopeId: id } }
            }).content
            const css = descriptor.styles
              .map(
                (s) =>
                  compiler.compileStyle({
                    source: s.content,
                    filename: args.path,
                    id,
                    scoped: s.scoped
                  }).code
              )
              .join('\n')
            return {
              contents:
                code +
                '\n__sfc__.__scopeId=' +
                JSON.stringify(id) +
                ';\nconst style=document.createElement("style"); style.textContent=' +
                JSON.stringify(css) +
                '; document.head.append(style); export default __sfc__;',
              loader: 'js',
              resolveDir: path.dirname(args.path)
            }
          })
        }
      }
    ]
  })
  fs.writeFileSync(path.join(out, 'bundle.js'), result.outputFiles[0].text)
  const css = fs
    .readFileSync(path.join(root, 'src/renderer/src/assets/tokens.css'), 'utf8')
    .replace(/@font-face\s*\{[^}]+\}/g, '')
  fs.writeFileSync(
    path.join(out, 'index.html'),
    `<!doctype html><html><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"><style>${css}</style><style>:root{--font-size-base:17rem;--bg-color:255 255 255;--text-color:#1d1d1f;--popup-opacity:.72;--window-radius:12px}body{background:white}main{padding:12px;display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px}main>div{max-width:100%}</style><div id="app"></div><script src="bundle.js"></script></html>`
  )
}
