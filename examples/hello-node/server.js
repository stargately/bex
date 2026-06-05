// The "agent": answers 200 OK on every GET (straight from the strategy doc).
// MESSAGE is overridable so a redeploy can visibly change the response.
const http = require("node:http");
const MESSAGE = process.env.MESSAGE || "OK2";
http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(MESSAGE);
  })
  .listen(process.env.PORT || 3000, () => {
    console.log(
      `hello-node listening on ${process.env.PORT || 3000}: "${MESSAGE}"`,
    );
  });
