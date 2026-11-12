const http=require('http'),fs=require('fs'),path=require('path');
const root=__dirname;
const files=new Map([
  ['/', ['CriteriaLab.html','text/html; charset=utf-8']],
  ['/criteria-import.js',['criteria-import.js','text/javascript; charset=utf-8']],
  ['/vendor/jszip.min.js',['vendor/jszip.min.js','text/javascript; charset=utf-8']],
  ['/vendor/pdf.min.mjs',['vendor/pdf.min.mjs','text/javascript; charset=utf-8']],
  ['/vendor/pdf.worker.min.mjs',['vendor/pdf.worker.min.mjs','text/javascript; charset=utf-8']]
]);
http.createServer((request,response)=>{
  const entry=files.get(new URL(request.url,'http://127.0.0.1').pathname);
  if(!entry){response.writeHead(404);response.end('Not found');return;}
  response.writeHead(200,{'Content-Type':entry[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  fs.createReadStream(path.join(root,entry[0])).pipe(response);
}).listen(4174,'127.0.0.1',()=>console.log('CriteriaLab: http://127.0.0.1:4174/'));
