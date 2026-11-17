"""IMG-08 generated model boundary; real worker HTTP, child and pixels stay live.

This entry is selected only by the explicit generated journey. It imports no MLX
or model packages, downloads nothing, and accepts only the generated catalog and
pixel expectations under the journey's own temporary directory.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

SCRIPTS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mote_vlm as vlm


class GeneratedFactory:
    def __call__(self, root, temporary):
        return GeneratedEngine(root, temporary)


class GeneratedEngine:
    def __init__(self, root, temporary):
        self.root = Path(root)
        self.directory = self.root.parent.parent

    def load(self):
        weights = b'Generated optional image model bytes'
        vlm.verify_assets(self.root, [('component/model.bin', len(weights), hashlib.sha256(weights).hexdigest())])
        (self.directory / 'model-child.pid').write_text(str(os.getpid()))
        return {'id': vlm.MODEL_ID, 'quantization': '4bit', 'revision': 'generated-img08-boundary',
                'engine': 'mlx', 'engineVersion': 'generated-no-mlx-loaded', 'promptVersion': vlm.PROMPT_VERSION}

    def infer(self, request):
        # Both decoding/normalization and interpretation validation are the
        # production implementation. Authored outcomes are not recognition QA.
        image, geometry = vlm.prepare_pixels(request)
        try:
            samples = json.loads((self.directory / 'expected-images.json').read_text())
            expected = samples[request['image']['imageView']['original']['sha256']]
            pixels = image.convert('RGB').tobytes()
            if hashlib.sha256(pixels).hexdigest() != expected['pixelsSha256']:
                raise vlm.VlmError('invalid_request')
            observation = {'operationId': request['operationId'], 'captureId': request['captureId'],
                           'originalSha256': request['image']['imageView']['original']['sha256'],
                           'viewId': request['image']['imageView']['viewId'], 'pixelBytes': len(pixels),
                           'pixelsSha256': hashlib.sha256(pixels).hexdigest(), 'pid': os.getpid()}
            with (self.directory / 'worker-requests.ndjson').open('a') as output:
                output.write(json.dumps(observation) + '\n')
            result = expected['interpretation']
            normalized = {'text': result['text'], 'regions': [
                {**region, 'x': region['x']/image.width, 'y': region['y']/image.height,
                 'width': region['width']/image.width, 'height': region['height']/image.height}
                for region in result['regions']]}
            return vlm.interpretation(json.dumps(normalized), geometry), {}, {'normalization': geometry.record()}
        finally:
            image.close()

    def close(self):
        pass


def main():
    model_root = Path(sys.argv[sys.argv.index('--model-root') + 1])
    directory = model_root.parent.parent
    (directory / 'worker.pid').write_text(str(os.getpid()))
    spec = importlib.util.spec_from_file_location('img08_generated_worker_http', SCRIPTS / 'vlm-server.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.VlmWorker = lambda root, **options: vlm.VlmWorker(root, factory=GeneratedFactory(), **options)
    module.main()


if __name__ == '__main__':
    main()
