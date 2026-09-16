"""Structured logging + metrics. One import everyone uses."""
import logging

# httpx logs every request at INFO including the full URL, which for Telegram and
# Discord means the bot token and the webhook secret in plain text — anyone with
# log access could post as us. Their warnings are still useful, so keep those.
_NOISY_LOGGERS = ("httpx", "httpcore", "telegram.ext", "telegram.bot")


def get_logger(name: str) -> logging.Logger:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    for noisy in _NOISY_LOGGERS:
        logging.getLogger(noisy).setLevel(logging.WARNING)
    return logging.getLogger(name)
