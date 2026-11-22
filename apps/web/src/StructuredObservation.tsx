import {Fragment} from 'react';
import type {UiPage} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';

/** Render observed fields as evidence, retaining repeated values and their origin. */
export function StructuredObservation({page}: {page?: UiPage}) {
  if (page?.version !== 3) return null;
  const sources = {text: moteText('显示文字'), description: moteText('无障碍描述'), state: moteText('界面状态'), ocr: moteText('文字识别')};
  return <section className="structured-observation"><p className="field-note">{moteText('仅为观察时窗内的文字。')}</p>
    {page.objects.map((object, index) => <dl className="discovery-material-facts" key={index}>{object.fields.map(field => <Fragment key={field.name}>
      <dt>{field.name.replaceAll('_', ' ')}</dt><dd>{field.values.map((value, valueIndex) => <div key={valueIndex}><small>{sources[value.source]}</small><pre className="library-original-text">{value.text}</pre></div>)}</dd>
    </Fragment>)}</dl>)}
  </section>;
}
