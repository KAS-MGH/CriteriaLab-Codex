const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const html=fs.readFileSync('CriteriaLab.html','utf8');
assert.doesNotMatch(html,/id="aiProvider"|AI-провайдер/,'provider routing must stay in the backend, not the user interface');
assert.doesNotMatch(html,/\.criteria-choices\.demo-active/,'demo mode must not make criteria upload look inactive');
assert.match(html,/action:'recognize',provider:'auto'/,'OCR provider must be selected by the backend');
assert.doesNotMatch(html,/action:'feedback'[\s\S]{0,300}text:\$\('essay'\)\.value/,'feedback request must not contain the full essay');
assert.equal(html,fs.readFileSync('publish-criterialab/index.html','utf8'),'published HTML must match the source HTML');
const elements=new Map();
for(const [,id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id,{
  value:'',textContent:'',innerHTML:'',hidden:/id="(?:finalScoreSummary|feedbackPreview)"/.test('id="'+id+'"'),
  checked:false,disabled:false,attributes:{},classList:{add(){},remove(){},toggle(){}},
  events:{},addEventListener(name,handler){this.events[name]=handler},setAttribute(k,v){this.attributes[k]=v},prepend(){},scrollIntoView(){},focus(){this.focused=true;}
});
const listeners={};
const zipModule=require('./vendor/jszip.min.js');
const context=vm.createContext({console,Date,URL,Blob,setTimeout,confirm:()=>true,
  JSZip:zipModule,
  DOMParser:class{parseFromString(xml){return{querySelector(){return null},getElementsByTagNameNS(uri,tag){if(tag!=='p')return[];return [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)].map(match=>({getElementsByTagNameNS(u,t){return [...match[1].matchAll(/<w:t>([\s\S]*?)<\/w:t>/g)].map(m=>({textContent:m[1]}))}}))}}}},
  document:{getElementById:id=>{if(/^teacherChange\d+$/.test(id))return null;assert(elements.has(id),'Unknown ID '+id);return elements.get(id)},querySelectorAll:()=>[],createElementNS:()=>({setAttribute(){}})},
  window:{scrollTo(){},print(){},addEventListener:(name,handler)=>listeners[name]=handler}
});
vm.runInContext(fs.readFileSync('criteria-import.js','utf8'),context);
vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
function run(code){return vm.runInContext(code,context)}
function approve(){elements.get('approve').onclick();}
run("reset();$('genre').value='custom';$('customGenre').value='Review Essay';");
assert.equal(elements.get('schoolClass').value,'');
assert.equal(run('genreValue()'),'Review Essay');
assert.equal(run("snapshot().fields.customGenre"),'Review Essay');
run('reset();');
elements.get('essay').value='Manually entered essay text.';
elements.get('essay').events.input();
assert.match(elements.get('textConfirmHint').textContent,/Следующий шаг/);
elements.get('toCriteria').onclick();
assert.equal(run('currentStep'),0);
assert.equal(elements.get('textConfirmed').focused,true);
assert.match(elements.get('status').textContent,/Поставьте галочку/);
elements.get('textConfirmed').checked=true;elements.get('textConfirmed').onchange();
assert.equal(elements.get('textConfirmHint').textContent,'');
elements.get('toCriteria').onclick();
assert.equal(run('currentStep'),1);
console.log('PASS: entered text highlights confirmation; blocked navigation focuses the checkbox; confirmation unlocks criteria');
run('loadDemo();');
assert.equal(elements.get('schoolClass').value,'9');
elements.get('finalScore').onclick();
assert.match(elements.get('finalScoreSummary').innerHTML,/15 \/ 20/);
approve();elements.get('generate').onclick();elements.get('preview').onclick();
assert.equal(elements.get('feedbackPreview').hidden,false);
assert.match(elements.get('previewMeta').textContent,/Work: DEMO-01/);
assert.equal(elements.get('previewText').textContent,elements.get('feedback').value);
elements.get('feedback').value+='\nTeacher edit';elements.get('feedback').oninput();
assert.match(elements.get('printText').textContent,/Teacher edit/);
run("criteria[0].score=4;invalidate();");
assert.match(elements.get('finalScoreSummary').innerHTML,/16 \/ 20/);
assert.equal(elements.get('feedbackPreview').hidden,true);
assert.equal(elements.get('printText').textContent,'');
assert.equal(elements.get('preview').disabled,true);
approve();elements.get('generate').onclick();
assert.match(elements.get('printText').textContent,/16 \/ 20/);
assert.match(html,/<select id="language"><option value="en">English[^<]*<\/option><option value="ru">[^<]*<\/option><option value="kk">/);
listeners.beforeprint();
assert.match(elements.get('printMeta').textContent,/Work: DEMO-01/);
run('reset();');listeners.beforeprint();
assert.equal(elements.get('printText').textContent,'');
run("loadDemo();criteria[0].score='';update();");elements.get('finalScore').onclick();
assert.match(elements.get('finalScoreSummary').innerHTML,/Не завершена/);
run('criteria[0].score=5;update();');
assert.match(elements.get('finalScoreSummary').innerHTML,/Не завершена/);
console.log('PASS: demo totals, score edits, incomplete scores, approval, preview, manual edits, language invalidation, reset, beforeprint');

async function checkStability(){
  const checks=[];
  function passed(message){checks.push(message);console.log('PASS: '+message)}
  const state=()=>JSON.parse(run('JSON.stringify(snapshot())'));
  const approveAndBuild=()=>{approve();assert.equal(run('approved'),true);elements.get('generate').onclick()};
  async function importText(text){
    await elements.get('draftFile').onchange({target:{files:[{size:Buffer.byteLength(text),text:async()=>text}],value:'draft.json'}});
  }
  run('reset();loadDemo();');
  run("criteria[0].score='4';criteria[0].comment='Teacher comment: проверено <&> қазақша';criteria[0].desc[3]='Custom descriptor: проверено';remarks[0].explanation='Teacher explanation';invalidate();");
  approveAndBuild();
  const baseline=state();
  for(let n=0;n<10;n++){
    for(const step of [0,1,2,3,2,1,0,3])run('go('+step+');');
    assert.deepEqual(state(),baseline);
    assert.equal(run('approved && feedbackFresh'),true);
  }
  passed('10 navigation cycles: fields, descriptors, scores, comments, remarks and approval unchanged');
  for(let n=0;n<10;n++){
    elements.get('generate').onclick();assert.equal(elements.get('feedback').value,baseline.feedback);
  }
  passed('10 repeated feedback builds: identical output');
  context.savedDownload=null;
  run('download=(name,data,type)=>{savedDownload={name,data,type};};');
  elements.get('save').onclick();
  assert.equal(context.savedDownload.name,'CriteriaLab-draft.json');
  assert.deepEqual(JSON.parse(context.savedDownload.data),baseline);
  assert.equal(run('dirty'),false);
  passed('Save button exports the complete snapshot as JSON');
  for(let n=0;n<10;n++){
    const text=JSON.stringify(state());
    run('reset();');await importText(text);
    assert.deepEqual(state(),baseline);
    assert.equal(run('approved || feedbackFresh || dirty'),false);
    assert.equal(elements.get('print').disabled,true);
    assert.equal(elements.get('printText').textContent,'');
    approveAndBuild();assert.deepEqual(state(),baseline);
  }
  passed('10 JSON save/import cycles: exact data restored; approval required; feedback reproduced');
  elements.get('feedback').value+='\nManual final sentence.';elements.get('feedback').oninput();
  const edited=state();run('reset();');await importText(JSON.stringify(edited));
  assert.deepEqual(state(),edited);assert.equal(elements.get('feedback').disabled,true);
  approve();assert.equal(elements.get('print').disabled,true);
  assert.equal(elements.get('feedback').value,edited.feedback);
  passed('Manual final feedback survives import; printing stays blocked until renewed feedback');
  const beforeInvalid=state();
  await importText('{invalid json');assert.deepEqual(state(),beforeInvalid);
  assert.match(elements.get('status').textContent,/Не удалось открыть черновик/);
  const bad=JSON.parse(JSON.stringify(beforeInvalid));bad.criteria[0].score=99;
  await importText(JSON.stringify(bad));assert.deepEqual(state(),beforeInvalid);
  assert.match(elements.get('status').textContent,/Некорректные критерии/);
  passed('Malformed JSON and invalid scores do not replace the current work');
  run('dirty=true;');context.confirm=()=>false;
  await importText(JSON.stringify(baseline));assert.deepEqual(state(),beforeInvalid);
  context.confirm=()=>true;
  passed('Cancelling replacement preserves the current draft');
  run('reset();loadDemo();');
  elements.get('reviewList').events.input({target:{dataset:{score:'0'},value:'4'}});
  assert.equal(run('criteria[0].score'),'4');assert.equal(run('approved'),false);
  const scored=state();elements.get('code').value='TEST-02';elements.get('code').events.input();
  assert.deepEqual(state().criteria,scored.criteria);
  passed('Score edit and work-code edit preserve criterion data and require approval');
  const descriptorInput={dataset:{c:'0',desc:'3'},value:'Edited descriptor'};
  elements.get('criteriaEditor').events.input({target:descriptorInput});
  assert.equal(run('criteria[0].desc[3]'),'Edited descriptor');
  assert.equal(run("criteria.every(c=>c.score===''&&c.comment==='') && remarks.length===0 && !approved"),true);
  passed('Descriptor edit retains the new descriptor and intentionally resets assessment');
  run('reset();loadDemo();');elements.get('essay').value+=' Changed source.';elements.get('essay').events.input();
  assert.equal(elements.get('textConfirmed').checked,false);
  assert.equal(run("criteria.every(c=>c.score==='') && !demoMode && !approved"),true);
  passed('Source-text edit intentionally clears assessment and text confirmation');
  const report='CriteriaLab — пункт 10: стабильность результата\nДата: 12 ноября 2026\n\n'+
    'Метод: выполнение JavaScript из CriteriaLab.html в Node.js с имитацией DOM. Проверены реальные обработчики, экспорт и импорт JSON; UI, реальное скачивание браузером и визуальный вид не проверялись.\n\n'+
    checks.map((c,i)=>(i+1)+'. PASS — '+c).join('\n')+
    '\n\nВывод: перечисленные сценарии сохранения и повторяемости проходят. Сброс после правки исходного текста/дескрипторов предусмотрен текущим кодом, это не случайная потеря при переходе. После импорта требуется повторное подтверждение и сборка; ручная редактура отзыва сохраняется в файле, но повторная сборка заменяет её текстом из полей.\n\nОстаётся: ручная проверка в браузере на этом компьютере; повтор этих же тестов после изменений. ИИ/OCR отсутствуют, стабильность модели здесь не оценивалась. Автоматическое восстановление после закрытия вкладки отсутствует: нужен сохранённый JSON.\n';
  fs.writeFileSync('CriteriaLab-point10-results.txt',report);
  checkTeacherControl();
  await checkCompactFeedback();
  checkStartOwnWork();
  await checkWorkInput();
  await checkCriteriaImport();
}
async function checkCriteriaImport(){
  context.confirm=()=>true;run('reset();go(1);');
  elements.get('downloadCriteriaTemplate').onclick();
  assert.equal(context.savedDownload.name,'CriteriaLab-criteria.txt');
  assert.equal(run('parseCriteriaText(savedDownload.data).length'),5);
  assert.equal(elements.get('criteriaForm').hidden,true);
  elements.get('showManualCriteria').onclick();assert.equal(elements.get('criteriaForm').hidden,false);
  run('go(2);go(1);');assert.equal(elements.get('criteriaForm').hidden,true);
  const source=JSON.parse(run('JSON.stringify(defaults().slice(0,2).map(c=>({name:c.name,max:c.max,desc:c.desc})))'));
  source[0].name='Custom criterion';source[0].desc[4]='Custom top descriptor';
  const json=JSON.stringify({format:'CriteriaLab-criteria',version:1,criteria:source});
  const file={name:'rubric.json',size:Buffer.byteLength(json),text:async()=>json};
  await elements.get('criteriaDropZone').events.drop({preventDefault(){},dataTransfer:{files:[file]}});
  assert.equal(elements.get('criteriaForm').hidden,false);
  assert.equal(run('criteria.length'),2);assert.equal(run('criteria[0].name'),'Custom criterion');
  assert.equal(run('criteria[0].desc[4]'),'Custom top descriptor');
  assert.equal(run("criteria.every(c=>c.score===''&&c.comment==='')"),true);
  const before=JSON.parse(run('JSON.stringify(snapshot())'));
  const bad=JSON.stringify({format:'CriteriaLab-criteria',version:1,criteria:[{name:'Incomplete',max:4,desc:['Only zero']}]});
  await elements.get('criteriaFile').onchange({target:{files:[{name:'bad.json',size:bad.length,text:async()=>bad}],value:'bad.json'}});
  assert.deepEqual(JSON.parse(run('JSON.stringify(snapshot())')),before);
  run('reset();loadDemo();');const demo=JSON.parse(run('JSON.stringify(snapshot())'));
  context.confirm=()=>false;
  await elements.get('criteriaDropZone').events.drop({preventDefault(){},dataTransfer:{files:[file]}});
  assert.deepEqual(JSON.parse(run('JSON.stringify(snapshot())')),demo);
  context.confirm=()=>true;
  await elements.get('criteriaDropZone').events.drop({preventDefault(){},dataTransfer:{files:[file]}});
  assert.equal(run("criteria.length===2 && criteria.every(c=>c.score===''&&c.comment==='') && !demoMode"),true);
  const txt=source.map(c=>['Критерий: '+c.name,'Максимум: '+c.max,...c.desc.map((d,i)=>i+': '+d)].join('\n')).join('\n\n');
  await elements.get('criteriaDropZone').events.drop({preventDefault(){},dataTransfer:{files:[{name:'rubric.txt',size:Buffer.byteLength(txt),text:async()=>txt}]}});
  assert.equal(run('criteria[0].name'),'Custom criterion');assert.equal(run('criteria[0].desc[4]'),'Custom top descriptor');
  const docxZip=new zipModule();
  const escaped=txt.split('\n').filter(Boolean).map(line=>'<w:p><w:r><w:t>'+line.replaceAll('&','&amp;')+'</w:t></w:r></w:p>').join('');
  docxZip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+escaped+'</w:body></w:document>');
  const docx=await docxZip.generateAsync({type:'nodebuffer'});
  await elements.get('criteriaDropZone').events.drop({preventDefault(){},dataTransfer:{files:[{name:'rubric.docx',size:docx.length,arrayBuffer:async()=>docx}]}});
  assert.equal(run('criteria[0].name'),'Custom criterion');assert.equal(run('criteria[0].desc[4]'),'Custom top descriptor');
  const unknown='Some unrelated document';
  const beforeUnknown=JSON.parse(run('JSON.stringify(snapshot())'));
  await elements.get('criteriaDropZone').events.drop({preventDefault(){},dataTransfer:{files:[{name:'rubric.txt',size:unknown.length,text:async()=>unknown}]}});
  assert.deepEqual(JSON.parse(run('JSON.stringify(snapshot())')),beforeUnknown);
  console.log('PASS: criteria choices, JSON/TXT/DOCX auto-fill, complete descriptors, invalid-file rejection and protected replacement');
}
async function checkWorkInput(){
  context.confirm=()=>true;run('reset();');
  const drop=elements.get('dropZone'),text='First paragraph.\n\nSecond paragraph.';
  let prevented=false;
  await drop.events.drop({preventDefault(){prevented=true},dataTransfer:{files:[{name:'essay.txt',size:text.length,text:async()=>text}]}});
  assert.equal(prevented,true);assert.equal(elements.get('essay').value,text);
  assert.equal(elements.get('textConfirmed').checked,false);
  assert.equal(elements.get('wordCount').textContent,'4 слов');
  elements.get('essay').value='Typed text';elements.get('essay').events.input();
  assert.equal(elements.get('essay').value,'Typed text');
  await drop.events.drop({preventDefault(){},dataTransfer:{files:[{name:'one.txt'},{name:'two.txt'}]}});
  assert.equal(elements.get('essay').value,'Typed text');
  await drop.events.drop({preventDefault(){},dataTransfer:{files:[{name:'essay.pdf',size:10}]}});
  assert.equal(elements.get('essay').value,'Typed text');
  assert.match(elements.get('status').textContent,/Поддерживаются TXT, JPG, JPEG и PNG/);
  const photo=Object.assign(new Blob(['fake image'],{type:'image/png'}),{name:'work.png'});
  context.confirm=()=>false;
  await drop.events.drop({preventDefault(){},dataTransfer:{files:[photo]}});
  assert.equal(elements.get('essay').value,'Typed text');assert.equal(run('photoURL'),null);
  context.confirm=()=>true;
  await drop.events.drop({preventDefault(){},dataTransfer:{files:[photo]}});
  assert.equal(elements.get('essay').value,'');assert.equal(elements.get('textConfirmed').checked,false);
  assert.equal(run("criteria.every(c=>c.score==='') && !approved"),true);
  assert(run('photoURL')!==null);
  run('reset();');
  console.log('PASS: drag-and-drop TXT imports text and preserves paragraphs; unsupported files rejected; photo replacement requires consent and clears stale text');
}
function checkStartOwnWork(){
  let prompts=0;
  const state=()=>JSON.parse(run('JSON.stringify(snapshot())'));
  context.confirm=()=>true;run('reset();loadDemo();');
  approve();elements.get('generate').onclick();
  context.confirm=()=>{prompts++;return false;};
  elements.get('startOwn').onclick();
  assert.equal(prompts,0);assert.equal(run('demoMode || dirty || approved || feedbackFresh'),false);
  assert.equal(elements.get('essay').value,'');assert.equal(run('currentStep'),0);
  assert.equal(elements.get('sourceFile').focused,true);
  assert.equal(run("criteria.every(c=>c.score===''&&c.comment==='') && remarks.length===0 && undoSnapshot===null"),true);
  context.confirm=()=>true;run('loadDemo();');
  elements.get('reviewList').events.input({target:{dataset:{score:'0'},value:'4'}});
  const editedDemo=state();context.confirm=()=>{prompts++;return false;};
  elements.get('startOwn').onclick();assert.deepEqual(state(),editedDemo);assert.equal(prompts,1);
  context.confirm=()=>true;elements.get('startOwn').onclick();assert.equal(elements.get('essay').value,'');
  elements.get('essay').value='My own text';elements.get('essay').events.input();
  context.confirm=()=>false;elements.get('startOwn').onclick();assert.equal(elements.get('essay').value,'My own text');
  context.confirm=()=>true;run('reset();loadDemo();');approve();elements.get('generate').onclick();
  elements.get('feedback').value+=' Manual edit.';elements.get('feedback').oninput();
  const editedFeedback=state();context.confirm=()=>false;elements.get('startOwn').onclick();assert.deepEqual(state(),editedFeedback);
  context.confirm=()=>true;
  console.log('PASS: starting own work clears untouched demo without warning; protects modified demo, own text and manual feedback; focuses upload');
}
async function checkCompactFeedback(){
  context.confirm=()=>true;run('reset();loadDemo();');
  run("criteria[0].original.comment='REJECTED ORIGINAL COMMENT';criteria[0].comment='Teacher approved final comment.';remarks.push({quote:'REJECTED QUOTE',correction:'REJECTED CORRECTION',explanation:'REJECTED EXPLANATION',type:'uncertain',include:false});update();");
  approve();await elements.get('generate').onclick();
  const feedback=elements.get('feedback').value;
  assert.equal(feedback.split('\n\n').length,4);
  const saved=JSON.parse(run('JSON.stringify(snapshot())'));
  for(const criterion of saved.criteria)assert(feedback.includes(criterion.comment));
  for(const remark of saved.remarks.filter(r=>r.include)){
    assert(feedback.includes(remark.quote));assert(feedback.includes(remark.correction));assert(feedback.includes(remark.explanation));
  }
  assert(!feedback.includes('REJECTED'));
  for(const id of ['strengths','priorities','next'])assert(feedback.includes(elements.get(id).value.replace(/\s+/g,' ')));
  assert(feedback.includes('Score: 15 / 20'));
  assert.equal(elements.get('printText').textContent,feedback);
  assert.doesNotMatch(html,/option value="(?:ru|kk)"/);
  assert.doesNotMatch(html,/action:'feedback'/);
  const before=elements.get('feedback').value;run('invalidate();buildFeedback();');
  assert.equal(elements.get('feedback').value,before);
  assert.equal(elements.get('printText').textContent,'');
  console.log('PASS: final English feedback preserves every approved comment and included correction without a second AI request');
}
function checkTeacherControl(){
  const checks=[];
  const state=()=>JSON.parse(run('JSON.stringify(snapshot())'));
  const passed=message=>{checks.push(message);console.log('PASS: '+message)};
  const demo=()=>{context.confirm=()=>true;run('reset();loadDemo();go(2);');};
  const input=(id,value)=>{elements.get(id).value=value;elements.get(id).events.input();};
  const score=value=>elements.get('reviewList').events.input({target:{dataset:{score:'0'},value}});
  demo();
  elements.get('approve').onclick();
  assert.equal(run('approved'),true);assert.equal(run('currentStep'),3);
  assert.equal(elements.get('approvalActions').hidden,true);
  assert.match(elements.get('finalScoreSummary').innerHTML,/15 \/ 20/);
  assert.match(elements.get('finalScoreSummary').innerHTML,/Замечаний в отзыве: <b>3/);
  elements.get('generate').onclick();assert.equal(elements.get('print').disabled,false);
  passed('Visible final summary and one-click teacher confirmation');
  demo();score('');elements.get('approve').onclick();
  assert.match(elements.get('finalScoreSummary').innerHTML,/укажите целый балл/);
  assert.equal(run('approved'),false);assert.equal(run('currentStep'),2);
  passed('Incomplete assessment is listed in summary and cannot be approved');
  demo();approve();elements.get('generate').onclick();
  const original=state();context.confirm=()=>false;
  for(const [id,value] of [['essay','Different essay'],['topic','Different topic'],['level','A2'],['genre','discussion'],['task','Different task'],['length','50 words']]){
    input(id,value);assert.deepEqual(state(),original);assert.equal(run('approved && feedbackFresh'),true);
  }
  const desc={dataset:{c:'0',desc:'3'},value:'Changed descriptor'};
  elements.get('criteriaEditor').events.input({target:desc});
  assert.equal(desc.value,original.criteria[0].desc[3]);assert.deepEqual(state(),original);
  const maximum={dataset:{c:'0',prop:'max'},value:'5',setCustomValidity(){}};
  elements.get('criteriaEditor').events.input({target:maximum});
  assert.equal(maximum.value,'4');assert.deepEqual(state(),original);
  elements.get('criteriaEditor').events.click({target:{dataset:{removeC:'0'}}});assert.deepEqual(state(),original);
  elements.get('addCriterion').onclick();assert.deepEqual(state(),original);
  passed('Rejecting source, level, rubric changes and deletion preserves complete approved work');
  let prompts=0;context.confirm=()=>{prompts++;return true;};
  input('essay',original.fields.essay+' First edit.');
  assert.equal(run("criteria.every(c=>c.score==='')"),true);
  assert.equal(elements.get('print').disabled,true);
  input('essay',original.fields.essay+' First edit. Second edit.');
  assert.equal(prompts,1);
  elements.get('undo').onclick();assert.deepEqual(state(),original);
  assert.equal(run('approved || feedbackFresh'),false);assert.equal(elements.get('undo').disabled,true);
  assert.equal(elements.get('printText').textContent,'');
  elements.get('undo').onclick();assert.deepEqual(state(),original);
  passed('One reset warning per editing session; undo restores original source and assessment, never approval');
  demo();const beforeScore=state();score('4');score('2');elements.get('undo').onclick();assert.deepEqual(state(),beforeScore);
  score('4');elements.get('reviewList').events.focusout();score('2');elements.get('undo').onclick();
  assert.equal(run('criteria[0].score'),'4');
  passed('Undo groups typed edits within a field; leaving a field starts a new undo step');
  demo();run('go(2);');score('4');elements.get('reviewList').events.focusout();
  approve();elements.get('generate').onclick();
  assert.equal(run('currentStep'),3);
  elements.get('undo').onclick();
  assert.equal(run('currentStep'),2);
  assert.equal(run('criteria[0].score'),3);
  assert.equal(elements.get('total').textContent,'15 / 20');
  assert.match(elements.get('reviewList').innerHTML,/data-score="0"[^>]*value="3"/);
  assert.equal(elements.get('print').disabled,true);
  passed('Score 3→4→undo restores visible input to 3 and total to 15/20, even after feedback assembly; returns to assessment');
  demo();run('go(2);');score('4');elements.get('reviewList').events.focusout();score('4');
  elements.get('undo').onclick();assert.equal(run('criteria[0].score'),3);
  passed('Duplicate score input events do not overwrite undo with an unchanged score');
  demo();const beforeComment=state();
  elements.get('reviewList').events.input({target:{dataset:{comment:'0'},value:'Teacher changed comment'}});
  assert.match(elements.get('finalScoreSummary').innerHTML||'',/.*/);
  elements.get('finalScore').onclick();assert.match(elements.get('finalScoreSummary').innerHTML,/деморазбора: 1/);
  elements.get('undo').onclick();assert.deepEqual(state(),beforeComment);
  passed('Comment edits are marked against the demo baseline and can be undone');
  demo();const beforeRemark=state();elements.get('remarks').events.click({target:{dataset:{removeR:'1'}}});
  assert.equal(run('remarks.length'),2);elements.get('undo').onclick();assert.deepEqual(state(),beforeRemark);
  elements.get('remarks').events.input({target:{dataset:{include:'1'},checked:false}});
  assert.equal(run('remarks[1].include'),false);elements.get('undo').onclick();assert.deepEqual(state(),beforeRemark);
  elements.get('addRemark').onclick();elements.get('undo').onclick();assert.deepEqual(state(),beforeRemark);
  passed('Undo restores deleted, added and excluded remarks');
  demo();const beforeRubric=state();
  elements.get('criteriaEditor').events.input({target:{dataset:{c:'0',desc:'3'},value:'Accepted descriptor'}});
  elements.get('undo').onclick();assert.deepEqual(state(),beforeRubric);
  elements.get('criteriaEditor').events.click({target:{dataset:{removeC:'0'}}});
  elements.get('undo').onclick();assert.deepEqual(state(),beforeRubric);
  elements.get('addCriterion').onclick();elements.get('undo').onclick();assert.deepEqual(state(),beforeRubric);
  passed('Undo restores rubric edits, added/deleted criteria and the assessment cleared with them');
  demo();score('4');run('reset();');assert.equal(elements.get('undo').disabled,true);
  demo();score('4');run('dirty=false;loadDemo();');assert.equal(elements.get('undo').disabled,true);
  passed('Reset and loading another work clear undo history');
  fs.writeFileSync('CriteriaLab-point12-results.txt','CriteriaLab — пункт 12: контроль преподавателя\n12 ноября 2026\n\nМетод: Node.js, JavaScript из CriteriaLab.html, имитация DOM. Реальная работа браузера и оформление не проверялись.\n\n'+checks.map((s,i)=>(i+1)+'. PASS — '+s).join('\n')+'\n\nОтмена на один шаг: редактирование одного поля группируется до потери фокуса. Данные восстанавливаются, подтверждение и актуальность отзыва не восстанавливаются. История не экспортируется, очищается при сбросе, загрузке другой работы и смене фото.\n');
}
async function checkTeacherFeedback(){
  const fb=()=>elements.get('feedback').value;
  const rebuild=()=>{run('invalidate();');assert.equal(elements.get('preview').disabled,true,'old feedback must be blocked after an edit');approve();elements.get('generate').onclick();};
  assert.doesNotMatch(html,/ru-RU|kk-KZ|Қазақша|kk:\[/,'Russian and Kazakh feedback options must be removed');
  run('reset();');assert.equal(elements.get('language').value,'en','reset keeps English feedback');
  run('loadDemo();');approve();elements.get('generate').onclick();
  const essayStart=elements.get('essay').value.slice(0,120);
  assert.equal(fb().includes(essayStart),false,'feedback must not contain the student text');
  assert.match(fb(),/Score: 15 \/ 20/);
  run("criteria[1].comment='Teacher comment: add one more example to the second reason.';");rebuild();
  assert.match(fb(),/Teacher comment: add one more example to the second reason\./,'edited comment appears in rebuilt feedback');
  run("remarks[0].correction='elections really help students';remarks[0].explanation='Custom explanation of agreement.';");rebuild();
  assert.match(fb(),/elections really help students/);assert.match(fb(),/Custom explanation of agreement\./);
  run('remarks[1].include=false;');rebuild();
  assert.equal(fb().includes('a candidates explain their plans'),false,'excluded remark is absent');
  elements.get('strengths').value='Custom strength sentence.';elements.get('next').value='Custom next step.';rebuild();
  assert.match(fb(),/Custom strength sentence\./);assert.match(fb(),/Custom next step\./);
  assert.equal(fb().includes(essayStart),false,'feedback still contains no student text');
  const draft=JSON.stringify({...JSON.parse(JSON.stringify(run('snapshot()'))),language:'kk'});
  await elements.get('draftFile').onchange({target:{files:[{size:Buffer.byteLength(draft),text:async()=>draft}],value:'draft.json'}});
  assert.equal(elements.get('language').value,'en','imported draft is always English');
  console.log('PASS: English-only feedback; edited comment, edited correction, excluded remark, strengths and next step reach the rebuilt feedback; student text never copied');
}
checkStability().then(checkTeacherFeedback).catch(error=>{console.error(error);process.exitCode=1});
