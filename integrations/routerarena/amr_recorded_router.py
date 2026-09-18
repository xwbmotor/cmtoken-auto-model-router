"""Copy into RouterArena/router_inference/router after collecting an AMR run.

This replays exact prompt-to-model decisions. It does not run Auto or measure
routing latency. Generation results must be imported from the SAME run.
"""
import json
import os
from .base_router import BaseRouter


class AMRRecordedRouter(BaseRouter):
    def __init__(self, router_name):
        super().__init__(router_name)
        with open(os.environ["AMR_ARENA_PREDICTIONS"], encoding="utf-8") as stream:
            rows = json.load(stream)
        self.decisions = {}
        for row in rows:
            prompt, model = row["prompt"], row["prediction"]
            self._validate_model(model)
            if prompt in self.decisions and self.decisions[prompt] != model:
                raise ValueError("Repeated prompt has differing decisions; import prediction files directly")
            self.decisions[prompt] = model

    def _get_prediction(self, query):
        if query not in self.decisions:
            raise ValueError("Prompt absent from frozen AMR run; no substitute prediction")
        return self.decisions[query]
