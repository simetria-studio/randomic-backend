const http = require('http');
const { createApp } = require('./app');
const { attachRealtime } = require('./realtime');

for (const name of ['DATABASE_URL', 'JWT_SECRET']) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const server = http.createServer(createApp());
const { matchmaker } = attachRealtime(server);
setInterval(() => matchmaker.tick(), 1000);
const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`listening on ${port}`));
