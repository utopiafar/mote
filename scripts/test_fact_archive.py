"""Synthetic ZIP-only regression tests; never open a user's backup or private files."""
from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from zipfile import ZipFile

SCRIPT = Path(__file__).with_name('extract-fact-archive.py')
spec = importlib.util.spec_from_file_location('extract_fact_archive', SCRIPT)
parser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parser)


def fact_document(blocks: list[str]) -> str:
    return '---\nhealth: synthetic-derived-do-not-import\n---\n' + ''.join(
        f'## <id:fn_{i}> 12:{i:02}:00 "{{}}"\n\n{text}\n'
        for i, text in enumerate(blocks, 1)
    )


class FactParserTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mote-facts-unittest-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = self.root/'fixture.zip'

    def make_archive(self, entries: dict[str, str | bytes]):
        with ZipFile(self.archive, 'w') as archive:
            for name, content in entries.items():
                archive.writestr(name, content)

    def run_cli(self, *args):
        output = self.root/'private-output'
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.archive), '--output', str(output), *args],
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        return output, {name: json.loads((output/f'{name}-private.json').read_text()) for name in ('facts', 'sample', 'cases')}

    def test_empty_archive_exports_empty_private_collections(self):
        self.make_archive({})
        output, files = self.run_cli()
        self.assertEqual(files['facts']['records'], [])
        self.assertEqual(files['sample']['records'], [])
        self.assertEqual(files['cases']['cases'], [])
        self.assertIn('caseGenerationNote', files['cases'])
        self.assertEqual(output.stat().st_mode & 0o777, 0o700)
        for path in output.iterdir(): self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_attachment_only_and_empty_day_do_not_extract_other_layers(self):
        self.make_archive({
            'workspace/fixture/Facts/2000/01/01.md':fact_document([]),
            'workspace/fixture/Facts/assets/image.png':b'\xff\xfe\x00not-text',
            'workspace/fixture/Facts/assets/image.txt':'synthetic derived OCR',
            'workspace/fixture/Insights/output.md':'synthetic derived summary',
            'settings.json':'{"synthetic":"must never be imported"}',
        })
        _, files = self.run_cli()
        self.assertEqual(files['facts']['factDocuments'], 1)
        self.assertEqual(files['facts']['excludedFactAttachments'], 2)
        self.assertEqual(files['facts']['records'], [])
        self.assertEqual(files['sample']['records'], [])
        self.assertEqual(files['cases']['cases'], [])

    def test_one_to_three_records_preserve_exact_input_without_fabricated_cases(self):
        for count in (1, 2, 3):
            with self.subTest(count=count):
                texts = [f'Synthetic input {i}.\n## An ordinary author heading\nUnchanged tail.' for i in range(count)]
                self.make_archive({'workspace/fixture/Fact/2000/01/01.md':fact_document(texts)})
                records, _ = parser.extract(self.archive)
                sample = parser.representative_sample(records)
                self.assertEqual(len(records), count)
                self.assertEqual(len(sample), count)
                self.assertEqual([r['text'] for r in records], ['\n\n'+text+'\n' for text in texts])
                self.assertEqual(parser.evaluation_cases(sample), [])
                self.assertNotIn('synthetic-derived-do-not-import', json.dumps(records))

    def test_four_records_on_different_days_have_no_minimum_day_group_requirement(self):
        self.make_archive({f'workspace/fixture/Facts/2000/01/{i:02}.md':fact_document([f'Synthetic number {i}, original note.']) for i in range(1,5)})
        records, _ = parser.extract(self.archive)
        sample = parser.representative_sample(records)
        cases = parser.evaluation_cases(sample)
        self.assertEqual(len(sample), 4)
        self.assertTrue(cases)
        ids = {r['id'] for r in sample}
        for case in cases: self.assertTrue(set(case['requiredEvidenceIds']) <= ids)

    def test_media_reference_only_and_whitespace_originals_do_not_crash_selection(self):
        for text, sample_count in [('![image](fs://synthetic.png)', 1), ('  \n\t ', 0)]:
            with self.subTest(sample_count=sample_count):
                self.make_archive({'workspace/fixture/Fact/2000/01/01.md':fact_document([text])})
                records, _ = parser.extract(self.archive)
                self.assertEqual(len(records), 1)
                sample = parser.representative_sample(records)
                self.assertEqual(len(sample), sample_count)
                self.assertEqual(parser.evaluation_cases(sample), [])

    def test_offset_changes_only_import_assumption_and_keeps_identity_and_raw_input(self):
        self.make_archive({'workspace/fixture/Fact/2000/01/01.md':fact_document(['Synthetic original.'])})
        default, _ = parser.extract(self.archive)
        self.assertTrue(default[0]['capturedAt'].endswith('+08:00'))
        for offset in ('+00:00', '+05:45', '-03:30', '+14:00', '-14:00'):
            with self.subTest(offset=offset):
                updated, _ = parser.extract(self.archive, offset)
                self.assertEqual(updated[0]['capturedAt'], updated[0]['capturedAtLocal']+offset)
                for key in ('id', 'text', 'sourceSlice', 'capturedAtLocal'):
                    self.assertEqual(updated[0][key], default[0][key])
        _, files = self.run_cli('--time-zone-offset=-03:30')
        self.assertEqual(files['facts']['timeZoneOffsetAssumption'], '-03:30')
        self.assertIn('-03:30', files['facts']['timestampNote'])

    def test_invalid_offsets_reject_before_export(self):
        self.make_archive({})
        for offset in ('8', '+8:00', 'Z', '+08:60', '+14:01', '+15:00', '-14:30', '-00:00', '+08:00 extra'):
            with self.subTest(offset=offset):
                with self.assertRaises(ValueError): parser.extract(self.archive, offset)
        output = self.root/'must-not-exist'
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.archive), '--output', str(output), '--time-zone-offset=+99:00'],
                                capture_output=True, text=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.exists())

    def test_existing_large_input_selection_stays_at_same_24_representatives(self):
        entries = {}
        for day in range(1,16):
            blocks = []
            for block in range(1,9):
                number = (day-1)*8+block
                blocks.append(('Synthetic text '+str(number)+'. ')*(1+number%17) + '\n'*(number%7) + ('31 47 59 ' if number%11==0 else ''))
            entries[f'workspace/fixture/Fact/2000/01/{day:02}.md'] = fact_document(blocks)
        entries['workspace/fixture/Fact/2000/02/01.md'] = '## <id:fn_1> 12:00:00 "{}"\n\n![image](fs://synthetic.png)\n'
        self.make_archive(entries)
        records, _ = parser.extract(self.archive)
        sample = parser.representative_sample(records)
        expected = [(1,1),(1,6),(2,4),(2,5),(3,7),(5,1),(5,3),(6,4),(7,7),(9,2),(9,3),(10,5),(11,1),(11,2),(11,3),(11,4),(11,6),(11,8),(13,2),(13,3),(13,5),(14,5),(15,6)]
        self.assertEqual([r['sourceFactId'] for r in sample], [f'Fact/2000/01/{day:02}.md#fn_{block}' for day,block in expected]+['Fact/2000/02/01.md#fn_1'])
        self.assertLessEqual(sum(len(r['text']) for r in sample), 40000)
        self.assertEqual(len(parser.evaluation_cases(sample)), 8)


if __name__ == '__main__':
    unittest.main()
