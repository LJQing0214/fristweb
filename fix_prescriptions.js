const fs = require('fs');
const path = require('path');

const prescriptionsFile = path.join(__dirname, 'data', 'prescriptions.json');
if (!fs.existsSync(prescriptionsFile)) {
  console.error('prescriptions.json 文件不存在！');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(prescriptionsFile, 'utf-8'));

let changed = false;
['handwritten', 'electronic'].forEach(type => {
  if (Array.isArray(data[type])) {
    data[type].forEach(p => {
      if (p.status === 'done' && p.dispensingStatus !== 'dispensed') {
        p.dispensingStatus = 'dispensed';
        changed = true;
      }
    });
  }
});

if (changed) {
  fs.writeFileSync(prescriptionsFile, JSON.stringify(data, null, 2), 'utf-8');
  console.log('历史数据已修复！');
} else {
  console.log('无需修复，数据已正常。');
} 