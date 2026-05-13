#!/usr/bin/env python3
"""Smart truncation: Keep full outputs, trim input data to fit"""

import json
import sys
from pathlib import Path

def estimate_tokens(text):
    """Rough estimate: 1 token ≈ 4 chars"""
    return len(text) // 4

def trim_input_data(input_json_str, max_input_tokens):
    """Intelligently trim the input JSON to fit token budget"""
    try:
        data = json.loads(input_json_str)
    except:
        return input_json_str  # Can't parse, return as-is
    
    # Priority: keep these fields
    keep_always = ['story_type', 'addresses', 'token_symbol', 'total_usd_value', 
                   'tx_count', 'time_range', 'address_context']
    
    # Trim address_context if it exists (often the biggest)
    if 'address_context' in data and isinstance(data['address_context'], dict):
        # Keep only first 5 addresses with context
        trimmed = dict(list(data['address_context'].items())[:5])
        data['address_context'] = trimmed
    
    # Remove verbose/redundant fields
    remove_if_long = ['raw_transactions', 'detailed_flow', 'all_interactions']
    for field in remove_if_long:
        if field in data:
            del data[field]
    
    return json.dumps(data, indent=2)

def process_example(example, max_tokens):
    """Process one training example"""
    messages = example.get('messages', [])
    if len(messages) != 3:
        return example  # Skip if not standard format
    
    system_msg = messages[0]['content']
    user_msg = messages[1]['content']
    assistant_msg = messages[2]['content']
    
    # Calculate current size
    system_tokens = estimate_tokens(system_msg)
    user_tokens = estimate_tokens(user_msg)
    assistant_tokens = estimate_tokens(assistant_msg)
    total = system_tokens + user_tokens + assistant_tokens
    
    if total <= max_tokens:
        return example  # Fits already
    
    # We need to trim. Keep system and assistant, reduce user input
    budget_for_user = max_tokens - system_tokens - assistant_tokens - 50  # 50 token buffer
    
    if budget_for_user < 200:
        return None  # Can't fit, skip this example
    
    # Find the JSON part in user message
    if ":\n\n" in user_msg:
        prefix, json_part = user_msg.split(":\n\n", 1)
        trimmed_json = trim_input_data(json_part, budget_for_user)
        new_user_msg = f"{prefix}:\n\n{trimmed_json}"
        
        return {
            'messages': [
                {'role': 'system', 'content': system_msg},
                {'role': 'user', 'content': new_user_msg},
                {'role': 'assistant', 'content': assistant_msg}
            ]
        }
    
    return example  # Couldn't parse, keep as-is

def main():
    input_file = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("training_data_v2.jsonl")
    max_tokens = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
    output_file = input_file.parent / f"{input_file.stem}_smart.jsonl"
    
    kept = []
    skipped = 0
    trimmed = 0
    
    with open(input_file) as f:
        for line in f:
            if not line.strip():
                continue
            example = json.loads(line)
            
            # Get original size
            orig_size = estimate_tokens(json.dumps(example))
            
            result = process_example(example, max_tokens)
            
            if result is None:
                skipped += 1
            else:
                new_size = estimate_tokens(json.dumps(result))
                if new_size < orig_size:
                    trimmed += 1
                kept.append(result)
    
    print(f"Original: {len(kept) + skipped} examples")
    print(f"Kept: {len(kept)}")
    print(f"  Trimmed: {trimmed}")
    print(f"  Unchanged: {len(kept) - trimmed}")
    print(f"Skipped (too long): {skipped}")
    
    with open(output_file, 'w') as f:
        for ex in kept:
            f.write(json.dumps(ex) + '\n')
    
    print(f"\nWrote: {output_file}")

if __name__ == '__main__':
    main()
