"""共享自定义 transformer：train 与 serve 都从这里 import，保证 pickle 兼容。"""
import numpy as np
from sklearn.base import BaseEstimator, TransformerMixin


class LengthFeats(BaseEstimator, TransformerMixin):
    """文本结构特征：log 长度、行数、标点密度（对 tier/complexity 是强信号）"""
    def fit(self, X, y=None):
        return self

    def transform(self, X):
        out = []
        for t in X:
            L = len(t)
            lines = t.count('\n') + 1
            punct = sum(t.count(c) for c in '，。；：？！,.;:?!')
            out.append([np.log1p(L) / 7.5, np.log1p(lines) / 4.0, punct / max(L, 1) * 10])
        return np.array(out)
