const path = require('path')
const pluginTester = require('babel-plugin-tester');
const plugin = require('../index');

pluginTester({
  plugin,
  pluginOptions: {
    moduleName: 'r-dom',
    builtIns: ['For'],
    generate: "dom",
    delegateEvents: true,
    alwaysWrap: true,
    alwaysCreateComponents: true,
    contextToCustomElements: true
  },
  title: 'Convert JSX',
  fixtures: path.join(__dirname, '__always_fixtures__'),
  snapshot: true
});
