import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // Component files export types/constants; this affects only HMR behavior.
      'react-refresh/only-export-components': 'off',
      // Noisy for async data loading in effects (setState after await).
      'react-hooks/set-state-in-effect': 'off'
    }
  },
  {
    // Plain JavaScript needs no explicit return types — which is what the shared config already
    // says, in a pattern that cannot reach here: `@electron-toolkit/eslint-config-ts` writes
    // `files: ['*.js', '*.mjs']`, and a flat-config pattern with no slash matches the CONFIG
    // DIRECTORY only. The exemption therefore applied to the repository root and nowhere below it,
    // so moving the development scripts from the root into scripts/ turned nine of their functions
    // into errors without a line of their code changing. Restated here with the glob the rule was
    // meant to have. Nothing else is relaxed: every other rule still runs over these files.
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
