import eslintConfig from '@electron-toolkit/eslint-config'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default [
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  eslintConfig,
  ...eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue']
      }
    }
  },
  {
    files: ['**/*.{js,jsx,vue}'],
    rules: {
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off'
    }
  },
  {
    files: ['src/main/**/*.{js,jsx}'],
    ignores: ['src/main/logging/ipc-main.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[source.value='electron'] > ImportSpecifier[imported.name='ipcMain']",
          message: '请从 src/main/logging/ipc-main.js 导入带日志捕获的 ipcMain。'
        },
        {
          selector: "MemberExpression[object.name='Electron'][property.name='ipcMain']",
          message: '请从 src/main/logging/ipc-main.js 导入带日志捕获的 ipcMain。'
        },
        {
          selector: "Property[key.name='ipcMain'][parent.parent.type='VariableDeclarator']",
          message: '请从 src/main/logging/ipc-main.js 导入带日志捕获的 ipcMain。'
        }
      ]
    }
  },
  eslintConfigPrettier
]
