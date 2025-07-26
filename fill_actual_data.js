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
      if (p.status === 'done' && (!Array.isArray(p.actualMedicines) || p.actualMedicines.length === 0)) {
        p.actualMedicines = Array.isArray(p.medicines) ? p.medicines.map(m => ({ name: m.name, weight: m.weight })) : [];
        p.actualCopies = p.copies || 1;
        changed = true;
      }
    });
  }
});

if (changed) {
  fs.writeFileSync(prescriptionsFile, JSON.stringify(data, null, 2), 'utf-8');
  console.log('历史实际配药数据已补全！');
} else {
  console.log('无需补全，数据已正常。');
} 