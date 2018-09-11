module.exports = {
    env: {
        es6: true,
        node: true
    },
    extends: ['eslint:recommended', 'plugin:prettier/recommended'],
    parserOptions: {
        ecmaVersion: 2017
    },
    rules: {
        'linebreak-style': ['error', 'unix'],
        'no-console': 'off',
        'prettier/prettier': [
            'error',
            {
                singleQuote: true,
                tabWidth: 4,
                semi: false
            }
        ]
    }
}
