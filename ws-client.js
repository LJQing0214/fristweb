(function(){
  console.log('页面脚本已加载');
  if (window.location.pathname.endsWith('login.html')) return; // 登录页不连接
  var ws = new WebSocket('ws://' + window.location.host);
  window.ws = ws;
  ws.onopen = () => {
      console.log('WebSocket连接已建立');
  };
  ws.onmessage = function(event) {
    try {
      var msg = JSON.parse(event.data);
      if (msg.type && typeof window['render'+capitalize(msg.type.replace(/Update$/, ''))] === 'function') {
        window['render'+capitalize(msg.type.replace(/Update$/, ''))](msg.data);
      }
    } catch(e) {
      // 可选：console.error('WS message error', e);
    }
  };
  ws.onclose = function() {
    // 可选：console.log('WebSocket closed');
  };
  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
})(); 