// 浏览器半边：注册到 window.__ModuleLoader__，factory 的 id 必须等于 package.json 的 name。
window.__ModuleLoader__.load({
  id: '@local/dsh-self-taught',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    function Hello() {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 10px',
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            color: 'inherit',
            opacity: 0.65,
            userSelect: 'none',
          },
        },
        h('span', { 'aria-hidden': true }, '👋'),
        h('span', null, 'Hello from my plugin'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'dsh-self-taught', order: 5 },
            Hello,
          ),
        );
      },
    };
  },
});
