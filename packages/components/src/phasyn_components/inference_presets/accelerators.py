"""Sampling contracts from the bundled, hash-pinned H3 acceleration manifests (runtimes/h3/loras)."""

from __future__ import annotations


H3_ACCELERATORS = {
    "lx-h3-fl2v-turbo4-v1.2-768p.json": (
        "fl2va",
        (4,),
        6.0,
        3.0,
        None,
        "c3d4a2cf618efea71b9e21a4baaa12d412f1eb6c2b6f86efacaf0ebb6814b689",
    ),
    "lx-h3-fl2v-turbo8-v1.0-768p.json": (
        "fl2va",
        (8,),
        6.0,
        3.0,
        None,
        "9b0efe3613b43a84e30febaa43af27432ea9d0711eac7bba904b2556b175f6d4",
    ),
    "lx-h3-ref2v-turbo4-v0.1.json": (
        "ref2va",
        (4,),
        12.0,
        3.0,
        None,
        "9e642fc8749c74f8da5e2382877ab5c7aa37b9a73b7fd0d6d457bd1b3cb1ae99",
    ),
    "lx-h3-ref2v-turbo8-v1.0-768p.json": (
        "ref2va",
        (8,),
        12.0,
        3.0,
        None,
        "9bac880b1a5d7ac052171cf6cce769f0cceaaa42ffa51de4b8e41143a2bdd2d2",
    ),
    "pai-h3-fl2va-acc8.json": (
        "fl2va",
        (8,),
        12.0,
        3.0,
        1.0,
        "0b29be7042d883970eb0c20774a9ba03d95669ed80a721bb4d21be8ea0d0a196",
    ),
    "pai-h3-ref2va-acc8-as4.json": (
        "ref2va",
        (4,),
        12.0,
        3.0,
        1.0,
        "111c82e669f6e20e628228172edf39395f1a9fc3ad049793895e542c0f55b18c",
    ),
    "pai-h3-ref2va-acc8-x3.json": (
        "ref2va",
        (3,),
        12.0,
        3.0,
        1.0,
        "111c82e669f6e20e628228172edf39395f1a9fc3ad049793895e542c0f55b18c",
    ),
    "pai-h3-ref2va-acc8.json": (
        "ref2va",
        (8,),
        12.0,
        3.0,
        1.0,
        "111c82e669f6e20e628228172edf39395f1a9fc3ad049793895e542c0f55b18c",
    ),
}
