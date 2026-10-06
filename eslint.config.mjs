// ESLint flat config (v10+). 替代 .eslintrc.json，规则逐条搬迁、语义不变。
// 旧 env(browser/es2021/node)仅影响 no-undef 类规则，本项目未启用，故省略。
// 弃用的格式化规则（semi/quotes/indent 等）在 v10 仍可执行，仅文档标 deprecated。
export default [
  { ignores: ['dist/**', '**/lib/**'] },
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-console': 'warn',
      'no-debugger': 'error',
      'semi': ['error', 'always'],
      'quotes': ['error', 'single', { avoidEscape: true }],
      'indent': ['error', 2, { SwitchCase: 1 }],
      'comma-dangle': ['error', 'never'],
      'arrow-spacing': ['error', { before: true, after: true }],
      'space-before-blocks': 'error',
      'space-before-function-paren': ['error', {
        anonymous: 'never',
        named: 'never',
        asyncArrow: 'always',
      }],
      'no-multiple-empty-lines': ['error', { max: 2, maxBOF: 1, maxEOF: 1 }],
      'curly': ['error', 'all'],
      'eqeqeq': ['error', 'always'],
      'brace-style': ['error', '1tbs'],
      'eol-last': 'error',
    },
  },
];
