import { moteText } from '@mote/shared/i18n';

const markPath='M5.25 16.5V7.5M5.25 10.75a3.25 3.25 0 0 1 6.5 0V16.5M11.75 10.75a3.25 3.25 0 0 1 6.5 0V12.2';

/** The Mote mark: one stroke for the m, its last leg resting on a dot. Ink follows the text color. */
export function MoteMark({className='mote-mark'}:{className?:string}) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d={markPath}/>
    <circle cx="18.25" cy="15.85" r="1.65"/>
  </svg>;
}

/** Content is on its way: rows in the shape of what replaces them. The words stay for assistive technology. */
export function Loading({label=moteText('正在读取…'),rows=3}:{label?:string;rows?:number}) {
  return <div className="loading skeleton" role="status">
    <span className="visually-hidden">{label}</span>
    {Array.from({length:rows},(_,index)=><span key={index} className="skeleton-row" aria-hidden="true"><i/><i/></span>)}
  </div>;
}

/** Visible content is being refreshed in place. */
export function LoadingLine({label=moteText('正在读取…')}:{label?:string}) {
  return <div className="loading loading-line" role="status"><span className="visually-hidden">{label}</span><i aria-hidden="true"/></div>;
}

/** A wait that owns the whole surface: the mark writes itself, then the dot settles. */
export function LoadingMark({label}:{label:string}) {
  return <div className="loading loading-mark" role="status">
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path pathLength={1} d="M5.25 16.5V7.5"/>
      <path pathLength={1} d="M5.25 10.75a3.25 3.25 0 0 1 6.5 0V16.5"/>
      <path pathLength={1} d="M11.75 10.75a3.25 3.25 0 0 1 6.5 0V12.2"/>
      <circle cx="18.25" cy="15.85" r="1.65"/>
    </svg>
    <span className="visually-hidden">{label}</span>
  </div>;
}
