"""wtpsplit-lite 的 HTTP 外壳。

    POST /split  {"text": "..."}  ->  {"sentences": ["...", ...]}

只做一件事：把一段文本切成句子。brain 那边再按字符预算装箱，见 apps/brains/src/split.ts。
"""

from fastapi import FastAPI
from pydantic import BaseModel
from wtpsplit_lite import SaT

app = FastAPI()

# 权重已经烘在镜像里（见 Dockerfile 的 build 步骤），这里只是加载，不联网。
sat = SaT("sat-3l-sm")


class SplitRequest(BaseModel):
    text: str


@app.get("/healthz")
def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.post("/split")
def split(request: SplitRequest) -> dict[str, list[str]]:
    # stride/block_size 是 wtpsplit-lite README 里"快且够好"的那组；hat 权重配大 stride 更稳。
    return {
        "sentences": sat.split(
            request.text, stride=128, block_size=256, weighting="hat"
        )
    }
