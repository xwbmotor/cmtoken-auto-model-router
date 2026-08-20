// mock 小模型端点（用于质量复核连通测试演示/验证）
const http = require('http');
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify({ task: 'extraction', tier: 'simple', complexity: 0.18, confidence: 0.91, reason: '工单分类' }));
}).listen(19001, '127.0.0.1', () => console.log('mock-classifier up on http://127.0.0.1:19001/classify'));
setInterval(() => {}, 1 << 30);
