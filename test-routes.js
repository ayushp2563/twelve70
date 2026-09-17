const fetch = require('node-fetch');
fetch('http://localhost:3000/api/admin/retraining/status')
  .then(res => console.log('status code:', res.status))
  .catch(err => console.error(err));
