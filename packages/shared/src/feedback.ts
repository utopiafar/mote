/** Only pass public software/build information; never pass client settings or captured content. */
export function githubFeedbackUrl(info: { version: string; platform: string; environment?: string }): string {
  const url = new URL('https://github.com/utopiafar/mote/issues/new');
  url.searchParams.set('template', 'bug_report.yml');
  // These keys match the field IDs in .github/ISSUE_TEMPLATE/bug_report.yml.
  url.searchParams.set('version', `Mote ${info.version} · ${info.platform}`);
  if (info.environment) url.searchParams.set('environment', info.environment);
  return url.href;
}
