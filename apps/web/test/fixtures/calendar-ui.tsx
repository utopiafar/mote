import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Actions} from '../../src/plugins/work/Actions';
import {ActionResults} from '../../src/plugins/work/ActionResults';
import {createApi} from '../../src/api';
import {configureLocale} from '@mote/shared/i18n';
import '../../src/styles.css';
import '../../src/actions-final.css';
configureLocale(()=> 'zh-CN');
const api=createApi({token:'generated-browser-fixture'});
function Fixture(){const [visible,setVisible]=useState(true);return <main style={{maxWidth:1100,margin:'auto',padding:24}}><button id="fixture-navigation" onClick={()=>setVisible(!visible)}>Generated navigation</button>{visible?<Actions api={api} onOpen={()=>{}}/>:<p>Generated other page</p>}<ActionResults api={api} evidenceId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"/></main>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
