import mammoth from 'mammoth';
import pdf from 'pdf-parse';
import type {Question} from './types';
export async function readDocument(file:File){
 if(file.size>10*1024*1024)throw Error('Максимальный размер — 10 МБ');
 const ext=file.name.toLowerCase().split('.').pop();const buf=Buffer.from(await file.arrayBuffer());let text='';
 if(ext==='docx'){if(!buf.subarray(0,2).equals(Buffer.from('PK')))throw Error('Повреждённый DOCX');text=(await mammoth.extractRawText({buffer:buf})).value;}
 else if(ext==='pdf'){if(buf.toString('ascii',0,5)!=='%PDF-')throw Error('Повреждённый PDF');text=(await pdf(buf)).text;}
 else throw Error('Допустимые форматы: DOCX и PDF');
 text=text.replace(/\r/g,'').trim();if(text.length<60)throw Error('Не удалось извлечь текст. Сканированный PDF пока не поддерживается.');return text.slice(0,110000);
}
export function parseExistingQuestions(text:string):Question[]{
 const lines=text.replace(/\r/g,'').split('\n').map(x=>x.trim()).filter(Boolean);
 let blocks:{number:number;parts:string[]}[]=[];let current:{number:number;parts:string[]}|null=null;
 for(const line of lines){const m=line.match(/^(\d{1,3})[.)]\s*(.+)$/);if(m){if(current)blocks.push(current);current={number:Number(m[1]),parts:[m[2]]};}else if(current)current.parts.push(line);}if(current)blocks.push(current);
 const key:Record<number,string>={};const keyTail=text.match(/(?:ключ ответов|answer key|ответы)\s*[:\n]([\s\S]*)/i)?.[1]??'';
 for(const m of keyTail.matchAll(/(?:^|[\s,;])(\d{1,3})\s*[-.:)]\s*([A-DА-Г])(?=$|[\s,;])/gim))key[Number(m[1])]=normalizeLetter(m[2]);
 return blocks.map(b=>{const parts=b.parts;let question:string[]=[];let options:{id:string;text:string}[]=[];let answer:string|null=key[b.number]??null;let currentOption=-1;
 for(const line of parts){const am=line.match(/^(?:answer|correct(?: answer)?|ответ|правильный ответ)\s*[:\-]\s*([A-DА-Г])/i);if(am){answer=normalizeLetter(am[1]);continue;}
 const om=line.match(/^([A-DА-Г])\s*[).:]\s*(.+)/i);if(om){options.push({id:normalizeLetter(om[1]),text:om[2]});currentOption=options.length-1;}else if(currentOption>=0)options[currentOption].text+=' '+line;else question.push(line);}
 const unique=options.length===4&&new Set(options.map(o=>o.id)).size===4;if(!unique)return null;
 return{id:crypto.randomUUID(),text:question.join(' ').trim(),options,correctOptionId:options.some(o=>o.id===answer)?answer:null,points:1,source:`Вопрос ${b.number} исходного файла`,needsReview:!answer||!options.some(o=>o.id===answer)} satisfies Question;
 }).filter((q):q is Question=>!!q&&!!q.text);
}
function normalizeLetter(s:string){const map:Record<string,string>={'А':'A','Б':'B','В':'C','Г':'D'};return map[s.toUpperCase()]||s.toUpperCase();}
