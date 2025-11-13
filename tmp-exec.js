const { exec } = require('child_process');
const cmd = "npm run ai-agent -- --strategy day_trade --expiry-type 0dte --symbols SPY,QQQ,AAPL,COIN,TSLA,GOOGL,GLD,SNOW,NVDA,SPX,AVGO,CVNA,PLTR,HOOD,MSFT,META,NFLX,AMD --once";
exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
  if (err) {
    console.error('ERR', err.message);
    console.error('code', err.code, 'killed', err.killed, 'signal', err.signal);
  }
  console.log('stdout length', stdout.length);
  console.log('done');
});
