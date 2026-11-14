const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
for(const [language,expected] of [['en-US','Downloads'],['zh-CN','下载'],['fr','Downloads']]) test(`workspace locale ${language}`,()=>{
 const parent={tagName:'BUTTON',closest:()=>false};
 const text={nodeValue:'下载',parentElement:parent};
 const page={nodeValue:'用户原文',parentElement:{closest:()=>true}};
 const root={};
 const document={body:{},documentElement:root,createTreeWalker(){let index=-1;const nodes=[text,page];return{nextNode(){return ++index<nodes.length},get currentNode(){return nodes[index]}}},querySelectorAll:()=>[]};
 vm.runInNewContext(fs.readFileSync(require.resolve('../firefox/localization.js'),'utf8'),{document,browser:{i18n:{getUILanguage:()=>language}},NodeFilter:{SHOW_TEXT:4},MutationObserver:class{observe(){}},queueMicrotask});
 assert.equal(text.nodeValue,expected);assert.equal(page.nodeValue,'用户原文');assert.equal(root.lang,language==='zh-CN'?'zh-cn':'en');
});
