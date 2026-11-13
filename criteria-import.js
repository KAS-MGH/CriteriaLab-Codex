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
  if(!result.length)return parseRubricTableText(text);
  return result;
}

function parseRubricTableText(text){
  const lines=text.replace(/\r/g,'').split('\n').map(line=>line.trim()).filter(Boolean);
  const criteria=[];let current=null,band=null;
  const finishBand=()=>{
    if(!current||!band)return;
    const description=band.parts.join(' ').replace(/\s+/g,' ').trim();
    for(let score=band.low;score<=band.high;score++)current.desc[score]=description;
    band=null;
  };
  const finishCriterion=()=>{
    finishBand();
    if(!current)return;
    current.max=Math.max(current.max||0,current.desc.length-1);
    if(current.max>0)criteria.push(current);
    current=null;
  };
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const wordHeading=line.match(/^Criterion\s+[A-Z]\s*:\s*(.+)$/i);
    const tableHeading=/^(?:Marks?\s+Descriptor|Achievement level)$/i.test(line);
    if(wordHeading){finishCriterion();current={name:wordHeading[1].trim(),max:null,desc:[]};continue;}
    if(tableHeading&&!current){
      const heading=[...lines.slice(Math.max(0,i-3),i)].reverse().find(x=>!x.startsWith('To what extent')&&!/^(?:Marks?|Descriptor)$/i.test(x));
      if(heading)current={name:heading,max:null,desc:[]};
      continue;
    }
    if(!current)continue;
    if(/^(?:Maximum|Максимум)\s*:\s*\d+$/i.test(line)){current.max=Number(line.match(/\d+/)[0]);continue;}
    if(/^(?:Marks?\s+Descriptor|Achievement level|Level descriptor)$/i.test(line))continue;
    const nextHeading=i+1<lines.length&&(/^(?:Marks?\s+Descriptor)$/i.test(lines[i+1])||/^To what extent/i.test(lines[i+1]));
    if(nextHeading&&band&&current.desc.length){finishCriterion();current={name:line,max:null,desc:[]};continue;}
    const scoreLine=line.match(/^(\d{1,2})(?:\s*[–—-]\s*(\d{1,2}))?(?:\s+|\s*[:.]\s*)?(.*)$/);
    if(scoreLine){
      const low=Number(scoreLine[1]),high=scoreLine[2]?Number(scoreLine[2]):low;
      if(high<low||high>20)throw Error('Некорректный диапазон баллов в таблице.');
      finishBand();band={low,high,parts:scoreLine[3]?[scoreLine[3]]:[]};
      continue;
    }
    if(band)band.parts.push(line);
  }
  finishCriterion();
  if(!criteria.length)throw Error('Не удалось найти критерии и баллы в таблице. Проверьте выделяемый текст или используйте образец.');
  return criteria;
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
