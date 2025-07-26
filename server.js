const express = require('express');
const WebSocket = require('ws');
const net = require('net');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = 3000;

// 托管静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 确保图片保存目录存在
const imageSaveDir = path.join(__dirname, 'public', 'images');
if (!fs.existsSync(imageSaveDir)) {
  fs.mkdirSync(imageSaveDir, { recursive: true });
}

// 创建HTTP服务器
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// 创建WebSocket服务器
const wss = new WebSocket.Server({ server });

// 存储所有连接的客户端
const clients = new Set();

// ==================== 系统数据管理 ====================
// 【修改说明】所有模拟数据集中管理，便于修改
// 修改位置：后端代码/server.js 第 25-120 行

// 移除所有模拟数据
let dispensingData = null;
let systemStatus = {};

// 药单数据存储
const prescriptions = {
  handwritten: [],
  electronic: []
};
// 日期自增编号
function generatePrescriptionId(type = 'handwritten') {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  // 统计当天已有的药单数量
  const list = (type === 'handwritten' ? prescriptions.handwritten : prescriptions.electronic)
    .filter(p => p.id && p.id.startsWith(dateStr));
  const count = list.length + 1;
  return dateStr + String(count).padStart(4, '0');
}

// ========== SC171V2 设备 TCP 服务端集成 ========== 
let sc171Buffer = '';

const SC171_PORT = 9000; // 监听端口

// 保存SC171V2连接的socket对象
let sc171Socket = null;

// 创建TCP服务端，等待SC171V2主动连接
const sc171Server = net.createServer((socket) => {
  console.log('SC171V2已连接:', socket.remoteAddress, socket.remotePort);
  sc171Socket = socket;

  socket.on('data', (data) => {
    sc171Buffer += data.toString();
    let idx;
    while ((idx = sc171Buffer.indexOf('\n')) !== -1) {
      const line = sc171Buffer.slice(0, idx).trim();
      sc171Buffer = sc171Buffer.slice(idx + 1);
      if (!line) continue;
      try {
        console.log('收到SC171原始数据:', line);
        const msg = JSON.parse(line);
        if (msg.type === 'newPrescription') {
          let imageUrl = '';
          if (msg.data.image && msg.data.image.startsWith('data:image/')) {
            const matches = msg.data.image.match(/^data:image\/(\w+);base64,(.+)$/);
            if (matches) {
              const ext = matches[1] || 'jpg';
              const base64Data = matches[2];
              const fileName = `presc_${Date.now()}_${Math.floor(Math.random()*10000)}.${ext}`;
              const filePath = path.join(imageSaveDir, fileName);
              fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
              imageUrl = `/images/${fileName}`;
            }
          } else if (msg.data.image && msg.data.image.startsWith('http')) {
            imageUrl = msg.data.image;
          } else {
            imageUrl = '';
          }
          const prescription = {
            id: generatePrescriptionId(msg.data.prescriptionType || 'handwritten'),
            patientName: msg.data.patientName || '',
            type: msg.data.prescriptionType || 'handwritten',
            title: msg.data.title || '新药单',
            status: 'waiting',
            dispensingStatus: 'not',
            image: imageUrl,
            copies: msg.data.copies || 1,
            medicines: msg.data.medicines || [],
            timestamp: new Date()
          };
          console.log('组装后的prescription对象:', prescription);
          if (prescription.type === 'handwritten') {
            prescriptions.handwritten.unshift(prescription);
          } else {
            prescriptions.electronic.unshift(prescription);
          }
          console.log('广播newPrescription:', prescription);
          broadcastUpdate('newPrescription', prescription);
          console.log('已执行broadcastUpdate');
          console.log('收到SC171新药单并已广播');
        }
      } catch (e) {
        console.error('SC171数据解析失败', e, '原始数据:', line);
      }
    }
  });

  socket.on('close', () => {
    console.log('SC171V2连接已关闭');
    if (sc171Socket === socket) sc171Socket = null;
  });

  socket.on('error', (err) => {
    console.error('SC171V2连接错误:', err.message);
  });
});

sc171Server.listen(SC171_PORT, '0.0.0.0', () => {
  console.log('SC171V2服务端已启动，监听9000端口');
});

// 提供函数：向SC171V2发送确认/修改后的药单信息
function sendPrescriptionToSC171V2(prescription) {
  return new Promise((resolve, reject) => {
    if (sc171Socket && !sc171Socket.destroyed) {
      // 监听一次性回复
      const onData = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg && msg.type === 'ackPrescription' && msg.success) {
            if (sc171Socket && !sc171Socket.destroyed) {
              sc171Socket.removeListener('data', onData);
            }
            console.log('收到SC171V2确认ackPrescription: 成功');
            resolve();
          } else if (msg && msg.type === 'ackPrescription' && !msg.success) {
            if (sc171Socket && !sc171Socket.destroyed) {
              sc171Socket.removeListener('data', onData);
            }
            console.log('收到SC171V2确认ackPrescription: 失败', msg.error);
            reject(new Error(msg.error || 'SC171V2返回失败'));
          }
        } catch (e) {
          // 非法数据忽略
        }
      };
      sc171Socket.on('data', onData);
      sc171Socket.write(JSON.stringify({
        type: 'confirmPrescription',
        data: prescription
      }) + '\n');
      console.log('已write确认药单信息给SC171V2，等待ack...');
      // 超时处理
      setTimeout(() => {
        if (sc171Socket && !sc171Socket.destroyed) {
          sc171Socket.removeListener('data', onData);
        }
        console.log('SC171V2无响应，超时');
        reject(new Error('SC171V2无响应'));
      }, 5000);
    } else {
      console.log('SC171V2未连接，无法发送');
      reject(new Error('SC171V2未连接，无法发送'));
    }
  });
}

// ==================== API 路由 ====================
app.use(cors());
app.use(express.json());

// 【修改说明】药箱状态API
app.get('/medicineBoxes', (req, res) => {
  res.json(medicineBoxes);
});

// 【修改说明】系统状态API
app.get('/systemStatus', (req, res) => {
  res.json(systemStatus);
});

// 【修改说明】药单列表API
app.get('/prescriptions', (req, res) => {
  res.json(prescriptions);
});

// 【修改说明】配药记录API（模拟数据）
app.get('/records', (req, res) => {
  res.json([]); // 暂时返回空数组，后续可接入真实数据来源
});

// ==================== WebSocket 连接处理 ====================
wss.on('connection', (ws) => {
  console.log('New client connected');
  clients.add(ws);

  // 发送初始数据
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      dispensing: dispensingData,
      medicineBoxes: medicineBoxes,
      systemStatus: systemStatus,
      prescriptions: prescriptions
    }
  }));

  // 监听客户端发送的消息
  ws.on('message', (message) => {
    const data = JSON.parse(message);
    console.log("接收到：", data.type);
    
    // 处理不同类型的消息
    switch(data.type) {
      case 'getStatus':
        // 【修改说明】发送系统状态数据
        ws.send(JSON.stringify({
          type: 'statusData',
          data: {
            medicineBoxes: medicineBoxes,
            systemStatus: systemStatus
          }
        }));
        break;
        
      case 'getPrescriptions':
        // 【修改说明】发送药单数据
        console.log('收到获取药单数据请求');
        console.log('手写药单数量:', prescriptions.handwritten.length);
        console.log('电子药单数量:', prescriptions.electronic.length);
        ws.send(JSON.stringify({
          type: 'prescriptionsData',
          handwritten: prescriptions.handwritten,
          electronic: prescriptions.electronic
        }));
        console.log('已发送药单数据');
        break;
        
      case 'dispensingUpdate':
        // 【修改说明】更新配药数据
        dispensingData = { ...dispensingData, ...data.data };
        broadcastUpdate('dispensingUpdate', dispensingData);
        break;
        
      case 'medicineBoxUpdate':
        // 【修改说明】更新药箱状态
        medicineBoxes = data.data;
        broadcastUpdate('medicineBoxUpdate', medicineBoxes);
        break;
        
      case 'systemStatusUpdate':
        // 【修改说明】更新系统状态
        systemStatus = data.data;
        broadcastUpdate('systemStatusUpdate', systemStatus);
        break;
        
      case 'newPrescription':
        // 【修改说明】添加新药单
        const prescription = data.data;
        if (prescription.type === 'handwritten') {
          prescriptions.handwritten.push(prescription);
        } else {
          prescriptions.electronic.push(prescription);
        }
        broadcastUpdate('newPrescription', prescription);
        savePrescriptionsToFile();
        break;
        
      case 'prescriptionUpdate':
        // 【修改说明】更新药单状态
        const { type, id, status, dispensingStatus } = data.data;
        const prescriptionList = type === 'handwritten' ? prescriptions.handwritten : prescriptions.electronic;
        const index = prescriptionList.findIndex(p => p.id === id);
        if (index >= 0) {
          if (status) prescriptionList[index].status = status;
          if (dispensingStatus) prescriptionList[index].dispensingStatus = dispensingStatus;
        }
        broadcastUpdate('prescriptionUpdate', data.data);
        break;
        
      case 'startDispensing':
        // 【修改说明】开始配药
        console.log('开始配药:', data.data);
        // 这里可以添加实际的配药逻辑
        broadcastUpdate('dispensingStarted', data.data);
        break;

      case 'confirmPrescriptionToSC171':
        // 前端请求发送确认药单到SC171V2
        sendPrescriptionToSC171V2(data.data)
          .then(() => {
            ws.send(JSON.stringify({ type: 'sendPrescriptionResult', success: true }));
          })
          .catch(err => {
            ws.send(JSON.stringify({ type: 'sendPrescriptionResult', success: false, error: err.message || '发送失败' }));
          });
        break;
      case 'savePrescription':
        // 保存药单修改
        const updated = data.data;
        if (!updated || !updated.id || !updated.type) break;
        const list = updated.type === 'handwritten' ? prescriptions.handwritten : prescriptions.electronic;
        const idx = list.findIndex(p => p.id === updated.id);
        if (idx >= 0) {
          list[idx] = { ...list[idx], ...updated };
          broadcastUpdate('prescriptionUpdate', list[idx]);
          console.log('药单已保存:', list[idx]);
          savePrescriptionsToFile();
        }
        break;
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
  });
});

// ==================== 广播更新 ====================
// 【修改说明】向所有客户端广播更新
function broadcastUpdate(type, data) {
  const message = JSON.stringify({ type, data });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ========== 新增：药单记录接口 ========== 
app.get('/api/records', (req, res) => {
  // 合并手写和电子药单
  const all = [...prescriptions.handwritten, ...prescriptions.electronic];
  // 按时间倒序
  all.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  res.json(all);
});

// ========== 药单完成接口 ========== 
app.post('/api/records/finish', (req, res) => {
  const { prescription_id, medicines, copies } = req.body;
  // 查找对应药单（假设 prescriptions.handwritten 和 prescriptions.electronic 合并查找）
  let record = prescriptions.handwritten.find(r => r.id === prescription_id) ||
               prescriptions.electronic.find(r => r.id === prescription_id);
  if (record) {
    record.status = 'done';
    record.dispensingStatus = 'dispensed'; // 新增：同步配药状态
    if (Array.isArray(medicines)) record.medicines = medicines;
    if (copies) record.copies = copies;
    savePrescriptionsToFile();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '未找到药单' });
  }
});

// ========== ESP8266重量TCP服务端 ========== 
const tcpWeightServer = net.createServer(socket => {
  socket.on('data', data => {
    try {
      const msg = data.toString().trim();
      const arr = JSON.parse(msg); // 支持数组或单个对象
      if (Array.isArray(arr)) {
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'weightUpdate', medicines: arr }));
          }
        });
        console.log('收到ESP8266药材数组:', arr);
      } else {
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'weightUpdate', medicines: [arr] }));
          }
        });
        console.log('收到ESP8266单个药材:', arr);
      }
    } catch (e) {
      console.log('收到ESP8266非JSON数据:', data.toString());
    }
  });
});
tcpWeightServer.listen(4000, () => {
  console.log('ESP8266重量TCP服务端已启动，监听4000端口');
});

// ========== STM32 TCP分包处理 ========== 
const stm32Server = net.createServer(socket => {
  let buffer = '';
  socket.on('data', data => {
    buffer += data.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        console.log('收到STM32数据:', msg);
        // 新增：温湿度数据推送
        if (msg.temperature !== undefined && msg.humidity !== undefined) {
          latestEnvData = { temperature: msg.temperature, humidity: msg.humidity };
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'envData', data: latestEnvData }));
            }
          });
        }
        if (msg.medicines) {
          if (currentDispense) {
            // 兼容单份和多份格式
            let medicinesData = msg.medicines;
            if (Array.isArray(medicinesData) && medicinesData.length > 0 && !Array.isArray(medicinesData[0])) {
              medicinesData = [medicinesData];
            }
            currentDispense.actualMedicines = medicinesData;
            if (typeof msg.actualCopies === 'number') {
              currentDispense.actualCopies = Math.max(0, Math.min(msg.actualCopies, currentDispense.copies || 0));
            }
            // 新增：累积每份最终重量（不影响原有逻辑）
            if (!currentDispense._finalMedicines || !Array.isArray(currentDispense._finalMedicines)) {
              currentDispense._finalMedicines = [];
            }
            if (typeof msg.actualCopies === 'number' && msg.actualCopies > 0) {
              currentDispense._finalMedicines[msg.actualCopies - 1] = JSON.parse(JSON.stringify(medicinesData[0]));
            }
            // 配药完成时将最终二维数据同步到actualMedicines
            if (msg.status === 'done' && Array.isArray(currentDispense._finalMedicines) && currentDispense._finalMedicines.length === currentDispense.copies) {
              currentDispense.actualMedicines = currentDispense._finalMedicines;
            }
            broadcastDispense(currentDispense);
            // 配药完成
            if (msg.status === 'done') {
              saveDispenseRecord({ ...currentDispense, status: 'done' });
              saveAllDoneRecordsToFile();
              let record = prescriptions.handwritten.find(r => r.id === currentDispense.id) ||
                           prescriptions.electronic.find(r => r.id === currentDispense.id);
              if (record) {
                record.status = 'done';
                record.dispensingStatus = 'dispensed';
                record.actualMedicines = currentDispense.actualMedicines || medicinesData || [];
                record.actualCopies = typeof currentDispense.actualCopies === 'number' ? currentDispense.actualCopies : msg.actualCopies;
              }
              broadcastFinish(currentDispense.id || currentDispense.prescription_id);
              savePrescriptionsToFile();
            }
          }
        }
      } catch (e) {
        console.log('解析失败:', e, line);
      }
    }
  });
});
stm32Server.listen(4001, '0.0.0.0', () => {
  console.log('STM32 TCP服务器已启动，监听4001端口');
});

// 移除所有setInterval模拟推送
const prescriptionsFile = path.join(__dirname, 'data', 'prescriptions.json');
// 加载本地药单数据
function loadPrescriptionsFromFile() {
  try {
    if (fs.existsSync(prescriptionsFile)) {
      const raw = fs.readFileSync(prescriptionsFile, 'utf-8');
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        if (Array.isArray(obj.handwritten)) prescriptions.handwritten = obj.handwritten;
        if (Array.isArray(obj.electronic)) prescriptions.electronic = obj.electronic;
      }
      console.log('已从本地文件加载药单数据');
    }
  } catch (e) {
    console.error('加载药单数据失败:', e);
  }
}
// 保存药单数据到本地
function savePrescriptionsToFile() {
  try {
    fs.mkdirSync(path.dirname(prescriptionsFile), { recursive: true });
    fs.writeFileSync(prescriptionsFile, JSON.stringify(prescriptions, null, 2), 'utf-8');
    //console.log('药单数据已保存到本地文件');
  } catch (e) {
    console.error('保存药单数据失败:', e);
  }
}
// 启动时加载
loadPrescriptionsFromFile();

// ========== 药品持久化存储 ========== 
const medicineBoxesFile = path.join(__dirname, 'data', 'medicineBoxes.json');
let medicineBoxes = [];

function loadMedicineBoxesFromFile() {
  try {
    if (fs.existsSync(medicineBoxesFile)) {
      const raw = fs.readFileSync(medicineBoxesFile, 'utf-8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) medicineBoxes = arr;
      console.log('已从本地文件加载药品数据');
    }
  } catch (e) {
    console.error('加载药品数据失败:', e);
  }
}
function saveMedicineBoxesToFile() {
  try {
    fs.mkdirSync(path.dirname(medicineBoxesFile), { recursive: true });
    fs.writeFileSync(medicineBoxesFile, JSON.stringify(medicineBoxes, null, 2), 'utf-8');
    //console.log('药品数据已保存到本地文件');
  } catch (e) {
    console.error('保存药品数据失败:', e);
  }
}
// 启动时加载
loadMedicineBoxesFromFile();

// ========== 药品 RESTful API ========== 
app.get('/api/medicineBoxes', (req, res) => {
  res.json(medicineBoxes);
});
app.post('/api/medicineBoxes', (req, res) => {
  const { name, level } = req.body;
  if (!name || typeof level !== 'number') {
    return res.status(400).json({ error: '参数错误' });
  }
  // 生成新id
  let maxId = medicineBoxes.length > 0 ? Math.max(...medicineBoxes.map(m => parseInt(m.id))) : 0;
  const newId = (maxId + 1).toString();
  // 状态和样式
  let status = '正常', statusClass = 'status-normal', icon = 'check-circle', levelClass = 'level-normal';
  if (level < 20) {
    status = '缺药'; statusClass = 'status-danger'; icon = 'exclamation-circle'; levelClass = 'level-danger';
  } else if (level < 50) {
    status = '注意'; statusClass = 'status-warning'; icon = 'exclamation-triangle'; levelClass = 'level-warning';
  }
  const newMedicine = { id: newId, name, level, status, statusClass, icon, levelClass };
  medicineBoxes.push(newMedicine);
  saveMedicineBoxesToFile();
  res.json(newMedicine);
});
app.delete('/api/medicineBoxes/:id', (req, res) => {
  const id = req.params.id;
  const idx = medicineBoxes.findIndex(m => m.id == id);
  if (idx === -1) return res.status(404).json({ error: '未找到药品' });
  medicineBoxes.splice(idx, 1);
  saveMedicineBoxesToFile();
  res.json({ success: true });
});
app.put('/api/medicineBoxes/:id', (req, res) => {
  const id = req.params.id;
  const { name, level } = req.body;
  const idx = medicineBoxes.findIndex(m => m.id == id);
  if (idx === -1) return res.status(404).json({ error: '未找到药品' });
  if (!name || typeof level !== 'number') return res.status(400).json({ error: '参数错误' });
  // 状态和样式
  let status = '正常', statusClass = 'status-normal', icon = 'check-circle', levelClass = 'level-normal';
  if (level < 20) {
    status = '缺药'; statusClass = 'status-danger'; icon = 'exclamation-circle'; levelClass = 'level-danger';
  } else if (level < 50) {
    status = '注意'; statusClass = 'status-warning'; icon = 'exclamation-triangle'; levelClass = 'level-warning';
  }
  medicineBoxes[idx] = { id, name, level, status, statusClass, icon, levelClass };
  saveMedicineBoxesToFile();
  res.json(medicineBoxes[idx]);
});

// ========== 配药流程核心变量 ========== 
let currentDispense = null; // 当前配药药单
let isDispensing = false;
let records = [];
let latestEnvData = { temperature: null, humidity: null };
// 新增：累积每份称重明细
let dispenseProgressArr = [];

function broadcastDispense(data) {
  // 确保actualMedicines字段始终存在且为最新
  if (!data.actualMedicines && data.medicines) {
    data.actualMedicines = data.medicines;
  }
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'dispense', data }));
    }
  });
}
function broadcastFinish(prescription_id) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'finish', prescription_id }));
    }
  });
}

// ========== 下发药单接口 ========== 
app.post('/api/dispense', (req, res) => {
  currentDispense = { ...req.body, actualCopies: 0, actualMedicines: [], status: 'doing', copies: req.body.copies };
  isDispensing = true;
  dispenseProgressArr = [];
  broadcastDispense(currentDispense);
  res.json({ success: true });
});

// ========== 获取当前配药药单 ========== 
app.get('/api/currentDispense', (req, res) => {
  res.json(currentDispense);
});

// ========== STM32推送配药进度 ========== 
app.post('/api/dispense/progress', (req, res) => {
  if (currentDispense) {
    let ac = typeof req.body.actualCopies === 'number' ? req.body.actualCopies : 0;
    currentDispense.actualCopies = Math.max(0, Math.min(ac, currentDispense.copies || 0));
    // 兼容单份和多份格式
    let medicinesData = req.body.medicines;
    if (Array.isArray(medicinesData) && medicinesData.length > 0 && !Array.isArray(medicinesData[0])) {
      medicinesData = [medicinesData];
    }
    currentDispense.actualMedicines = medicinesData;
    broadcastDispense(currentDispense);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '无配药任务' });
  }
});

// ========== STM32推送整单完成 ========== 
app.post('/api/dispense/finish', (req, res) => {
  if (currentDispense) {
    currentDispense.status = 'done';
    // 兼容单份和多份格式
    let medicinesData = req.body.medicines;
    if (Array.isArray(medicinesData) && medicinesData.length > 0 && !Array.isArray(medicinesData[0])) {
      medicinesData = [medicinesData];
    }
    currentDispense.actualMedicines = medicinesData;
    let ac = typeof req.body.actualCopies === 'number' ? req.body.actualCopies : 0;
    currentDispense.actualCopies = Math.max(0, Math.min(ac, currentDispense.copies || 0));
    saveDispenseRecord(JSON.parse(JSON.stringify(currentDispense)));
    saveAllDoneRecordsToFile();
    broadcastDispense(currentDispense);
    broadcastFinish(currentDispense.prescription_id);
    currentDispense = null;
    isDispensing = false;
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '无配药任务' });
  }
});

// ========== 获取历史药单 ========== 
app.get('/api/records', (req, res) => {
  res.json(records);
});

// ========== 历史配药记录持久化 ========== 
const recordsFile = path.join(__dirname, 'data', 'records.json');

function saveAllDoneRecordsToFile() {
  try {
    // 合并所有已完成的药单
    const all = [...prescriptions.handwritten, ...prescriptions.electronic].filter(r => r.status === 'done');
    fs.mkdirSync(path.dirname(recordsFile), { recursive: true });
    fs.writeFileSync(recordsFile, JSON.stringify(all, null, 2), 'utf-8');
    console.log('所有已完成药单已保存到 records.json');
  } catch (e) {
    console.error('保存 records.json 失败:', e);
  }
}

function loadRecordsFromFile() {
  try {
    if (fs.existsSync(recordsFile)) {
      const raw = fs.readFileSync(recordsFile, 'utf-8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) records = arr;
      console.log('已从本地文件加载历史配药记录');
    } else {
      records = [];
      console.log('未找到历史配药记录文件，将在首次保存时自动创建');
    }
  } catch (e) {
    console.error('加载历史配药记录失败:', e);
    records = [];
  }
}

function saveRecordsToFile() {
  try {
    fs.mkdirSync(path.dirname(recordsFile), { recursive: true });
    fs.writeFileSync(recordsFile, JSON.stringify(records, null, 2), 'utf-8');
    console.log('历史配药记录已保存到本地文件');
  } catch (e) {
    console.error('保存历史配药记录失败:', e);
  }
}

// ========== STM32推送配药完成/前端配药完成时保存记录 ========== 
function saveDispenseRecord(dispense) {
  if (!dispense) return;
  // 只保存核心字段，避免冗余
  const record = {
    id: dispense.id,
    patientName: dispense.patientName,
    type: dispense.type,
    copies: dispense.copies,
    medicines: dispense.medicines,
    actualMedicines: dispense.actualMedicines,
    actualCopies: dispense.actualCopies,
    status: dispense.status,
    dispensingStatus: dispense.dispensingStatus,
    image: dispense.image,
    timestamp: dispense.timestamp || new Date().toISOString()
  };
  records.push(record);
  saveRecordsToFile();
}

// 启动时加载历史记录
loadRecordsFromFile();

// ========== 启动时补全历史 actualMedicines 字段 ========== 
let changed = false;
records.forEach(r => {
  if (r.status === 'done' && (!Array.isArray(r.actualMedicines) || r.actualMedicines.length === 0)) {
    // 补全为二维数组，每份都等于应称量
    const copies = r.copies || 1;
    if (Array.isArray(r.medicines)) {
      r.actualMedicines = Array.from({length: copies}, () =>
        r.medicines.map(m => ({ name: m.name, weight: m.weight }))
      );
      r.actualCopies = copies;
      changed = true;
    }
  }
});
if (changed) {
  saveRecordsToFile();
  console.log('历史药单actualMedicines已补全！');
} else {
  console.log('无需补全，所有历史药单已完整。');
}