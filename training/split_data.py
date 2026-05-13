#!/usr/bin/env python3
"""Split training data into train/valid/test sets for mlx-lm"""

import json
import random
from pathlib import Path

def main():
    import sys
    input_file = Path(sys.argv[1] if len(sys.argv) > 1 else "training_data.jsonl")
    output_dir = Path("data")
    output_dir.mkdir(exist_ok=True)
    
    # Read all examples
    with open(input_file) as f:
        examples = [json.loads(line) for line in f if line.strip()]
    
    print(f"Loaded {len(examples)} examples")
    
    # Shuffle
    random.seed(42)
    random.shuffle(examples)
    
    # Split: 90% train, 5% valid, 5% test
    n = len(examples)
    train_end = int(n * 0.90)
    valid_end = int(n * 0.95)
    
    train = examples[:train_end]
    valid = examples[train_end:valid_end]
    test = examples[valid_end:]
    
    print(f"Train: {len(train)}, Valid: {len(valid)}, Test: {len(test)}")
    
    # Write splits
    for name, data in [("train", train), ("valid", valid), ("test", test)]:
        with open(output_dir / f"{name}.jsonl", "w") as f:
            for ex in data:
                f.write(json.dumps(ex) + "\n")
        print(f"Wrote {output_dir / name}.jsonl")

if __name__ == "__main__":
    main()
