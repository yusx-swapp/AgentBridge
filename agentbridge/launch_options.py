"""The small, shared CLI launch-settings contract."""


def validate_launch_options(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or value.keys() - {"permission_mode", "extra_args"}:
        raise ValueError("launch_options only supports permission_mode and extra_args")
    for key, item in value.items():
        if not isinstance(item, str) or len(item) > 4096 or any(ord(c) < 32 for c in item):
            raise ValueError(f"{key} must be a single-line string of at most 4096 characters")
    return dict(value)
