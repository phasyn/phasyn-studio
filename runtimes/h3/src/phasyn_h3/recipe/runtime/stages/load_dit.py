"""load_dit: make the DiT resident (or layerwise-configured) and report residency.

The residency document names the component key inside *this* actor; it is a
hint for ``denoise_av`` on the same actor, never a cross-process handle.  The component stays ``resident_idle`` after this stage so
the denoise stage reuses it (whatever its between-use policy says; that policy
applies after ``denoise_av``).  ``resident_components`` lists it for the control
plane, which accounts it as a component lease until the actor reports it gone.
A DiT kept in host memory by the previous job (``host_cached``) is restored
here instead of being read from the checkpoint again.
"""

from __future__ import annotations

from phasyn_h3.recipe.abi.stage import StageResult
from phasyn_h3.recipe.abi.timeutil import now_rfc3339

from .. import PROVIDER_ID, PROVIDER_VERSION
from ..bundles import write_metadata_output
from .common import StageRun


def run(run: StageRun) -> StageResult:
    prepared = run.read_json_input("prepared", required=False)
    run.progress("load_dit", "items", 0, 1)
    with run.provider.use_component(run, "transformer", keep_on_device=True) as module:
        from ..accel_load import check_resident_dit, summary

        lease = run.provider.last_lease("transformer")
        handle = lease.handle if lease is not None else None
        facts = dict(getattr(handle, "facts", {}) or {})
        check_resident_dit(facts, run.policy)  # the variant key carries quant/AdaLN; this re-checks the built DiT
        arch = getattr(module, "arch", None)
        document = {
            "schema_version": "1.0",
            "kind": "h3_dit_residency",
            "provider_id": PROVIDER_ID,
            "provider_version": PROVIDER_VERSION,
            "actor_instance_id": run.provider.actor_instance_id,
            "device_uuid": run.ctx.device.get("device_uuid"),
            "component_key": None if lease is None else lease.component_key,
            "state_after_stage": "resident_idle",
            "allocated_bytes": None if lease is None else lease.allocated_bytes,
            "peak_loading_bytes": None if lease is None else lease.peak_loading_bytes,
            "policy": run.policy.components["transformer"].as_dict(),
            "attention": {
                "requested": run.policy.attention_provider_requested,
                "effective": run.policy.attention_provider_effective,
                "sglang_backend": run.policy.sglang_attention_backend,
                "reject_quadratic_materialization": run.policy.reject_quadratic_materialization,
            },
            "architecture": {
                "adaln_curve_grid": getattr(arch, "adaln_curve_grid", None),
                "time_embed_dim": getattr(arch, "time_embed_dim", None),
                "num_layers": getattr(arch, "num_layers", None),
            },
            "load_facts": facts,
            "acceleration": summary(run.policy),  # effective approximate knobs (provenance)
            "prepared_present": prepared is not None,
            "observed_at": now_rfc3339(),
        }
    if lease is not None:
        current = run.provider.registry.get(lease.component_key)
        document["state_after_stage"] = current.state if current is not None else "absent"
        transfer = run.provider.registry.entry_facts(lease.component_key).get("last_transfer") or {}
        document["acquired_by"] = transfer.get("kind", "reuse")
        device, _host = run.provider.registry.residency_report()
        document["resident_components"] = [c for c in device if c["component_key"] == lease.component_key]
        document["residency_policy"] = run.policy.components["transformer"].residency.as_dict()
    run.outputs.append(write_metadata_output(run.output_dir, "residency", document))
    run.progress("load_dit", "items", 1, 1)
    return run.result()


__all__ = ["run"]
