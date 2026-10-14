# Acknowledgements

Bicho JavaScript sends exception logs using the OpenTelemetry Protocol (OTLP).

- [OTLP specification](https://opentelemetry.io/docs/specs/otlp/)
- [Exception log conventions](https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-logs/)

This SDK implements OTLP/HTTP JSON directly. It does not bundle the OpenTelemetry SDK or protobuf schemas.
