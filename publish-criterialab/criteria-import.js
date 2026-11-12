'use strict';

function parseCriteriaText(text){
  const lines=text.replace(/\r/g,'').split('\n').map(line=>line.trim()).filter(Boolean);
  const result=[];let current=null,lastScore=null;
  for(const line of lines){
    const heading=line.match(/^(?:Критерий|Criterion)\s*:\s*(.+)$/i);
    if(heading){current={name:heading[1].trim(),max:null,desc:[]};result.push(current);lastScore=null;continue;}
    if(!current)continue;
    const maximum=line.match(/^(?:Максимум|Max(?:imum)?)\s*:\s*(\d+)$/i);
    if(maximum){current.max=Number(maximum[1]);lastScore=null;continue;}
    const descriptor=line.match(/^(?:(?:Балл|Score)\s*)?(\d{1,2})\s*[:.—-]\s*(.+)$/i);
    if(descriptor){const score=Number(descriptor[1]);current.desc[score]=descriptor[2].trim();lastScore=score;continue;}
    if(lastScore!==null&&current.desc[lastScore])current.desc[lastScore]+=' '+line;
  }
  if(!result.length)throw Error('Не найдены строки «Критерий: ...». Скачайте образец и сохраните его как TXT, DOCX или PDF с выделяемым текстом.');
  return result;
}

async function extractCriteriaText(file){
  if(/\.txt$/i.test(file.name))return file.text();
  if(/\.docx$/i.test(file.name)){
    if(typeof JSZip==='undefined')throw Error('Не удалось загрузить модуль Word. Обновите страницу вместе с папкой vendor.');
    const zip=await JSZip.loadAsync(await file.arrayBuffer());
    const entry=zip.file('word/document.xml');
    if(!entry)throw Error('В файле Word не найден основной текст.');
    const xml=new DOMParser().parseFromString(await entry.async('string'),'application/xml');
    if(xml.querySelector('parsererror'))throw Error('Не удалось прочитать текст Word.');
    return [...xml.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main','p')].map(p=>[...p.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main','t')].map(t=>t.textContent).join('')).join('\n');
  }
  if(/\.pdf$/i.test(file.name)){
    let pdfjs;
    try{pdfjs=await import('./vendor/pdf.min.mjs');}
    catch{throw Error('Не удалось открыть модуль PDF. Откройте страницу через локальный сервер или опубликованный сайт вместе с папкой vendor.');}
    pdfjs.GlobalWorkerOptions.workerSrc='./vendor/pdf.worker.min.mjs';
    const document=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
    if(document.numPages>30)throw Error('В PDF больше 30 страниц.');
    const pages=[];
    for(let i=1;i<=document.numPages;i++){
      const page=await document.getPage(i),content=await page.getTextContent();
      const rows=[];let row='',lastY=null;
      for(const item of content.items){
        if(!('str' in item))continue;
        const y=item.transform?.[5];
        if(lastY!==null&&typeof y==='number'&&Math.abs(y-lastY)>2){rows.push(row);row='';}
        row+=(row?' ':'')+item.str;
        if(item.hasEOL){rows.push(row);row='';lastY=null;}else lastY=y;
      }
      if(row)rows.push(row);
      pages.push(rows.join('\n'));
    }
    const text=pages.join('\n');
    if(!text.trim())throw Error('В PDF нет выделяемого текста. Для скана или фото требуется распознавание, которое пока не подключено.');
    return text;
  }
  throw Error('Поддерживаются JSON, TXT, DOCX и PDF.');
}
