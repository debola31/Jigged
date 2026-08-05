-- Demo template v4: every part carries a markup pricing tier.
--
-- SYMPTOM. The Parts page showed "Incomplete — needs setup (routing/materials, or a
-- vendor cost) before it can be quoted" against 31 of the demo's 45 parts — every raw
-- bar, plate, sheet, fastener and consumable, plus the five sub-assemblies and six
-- finished parts v3 happened not to price. A demo that flags two thirds of its own
-- catalogue as unfinished teaches the opposite of what it is for.
--
-- CAUSE. `get_priceable_part_ids()` is the single source of truth behind that marker,
-- and it is a TWO-part test:
--
--   costable  = a bought part with a non-expired procurement tier, or a made part whose
--               routing ops are all priced and whose BOM children are all costable
--   priceable = costable AND the part has its OWN part_pricing_tiers row carrying a
--               non-null markup_percent
--
-- v3 satisfied the first half everywhere and the second half for only 14 parts. The
-- warning was therefore correct — a stick of 1018 with a vendor cost but no markup
-- genuinely cannot be quoted — but it described a template that was under-built, not a
-- product that was broken.
--
-- Note the legend under the toolbar names only the costable half ("routing/materials, or
-- a vendor cost"), which is why this read as a seeding bug rather than missing markup.
-- That wording is an app-side inaccuracy, left alone here.
--
-- WHY EVERY PART, INCLUDING RAW STOCK. Asked of production rather than assumed: across
-- the two real companies EVERY part carries a pricing tier — 630/630 bought and
-- 7816/7816 made at Contour — 8439 of 8446 with exactly one, median markup 25% for both
-- sources. Shops do put a rate on material, because customers do buy cut-offs and
-- remnants. Seeding raw stock without one was the anomaly, not the fix.
--
-- Markups follow that distribution instead of being invented: materials at the 25%
-- median, hardware a little above it (small parts, handled individually), machined goods
-- higher still — pass-through material carries less margin than work you performed. A
-- handful keep a quantity break, which real data also shows (7 parts with 2-3 tiers).
--
-- Guarded by `test_every_seeded_part_is_priceable`, which asserts the demo shows ZERO
-- setup warnings by calling the same RPC the page calls. Counting warnings by eye is how
-- this shipped.

UPDATE public.demo_data_templates SET is_active = false
 WHERE name = 'default' AND is_active;

INSERT INTO public.demo_data_templates (name, version, is_active, template_data)
VALUES ('default', 4, true, $json$
{
  "jobs": [
    {
      "_ref": "j_apex_widgets",
      "parts": [
        {
          "_ref": "jp_apex_widget",
          "part_ref": "p_widget100",
          "quantity": 25,
          "sequence": 10,
          "operations": [
            {
              "note": "Ran clean, no tool changes.",
              "days_ago": 12,
              "sequence": 10,
              "author_index": 1,
              "completed_quantity": 25
            },
            {
              "days_ago": 9,
              "sequence": 20,
              "author_index": 2,
              "completed_quantity": 25
            },
            {
              "status": "completed",
              "days_ago": 4,
              "sequence": 30
            },
            {
              "days_ago": 1,
              "sequence": 40,
              "author_index": 1,
              "completed_quantity": 18
            },
            {
              "note": "First ten through the CMM, released to ship.",
              "days_ago": 1,
              "sequence": 50,
              "author_index": 3,
              "completed_quantity": 10
            }
          ],
          "unit_price": 145.0,
          "routing_ref": "r_widget100"
        },
        {
          "_ref": "jp_apex_pin",
          "part_ref": "p_pin200",
          "quantity": 50,
          "sequence": 20,
          "operations": [
            {
              "days_ago": 11,
              "sequence": 10,
              "author_index": 2,
              "completed_quantity": 50
            },
            {
              "status": "sent",
              "days_ago": 3,
              "sequence": 20
            }
          ],
          "unit_price": 38.5,
          "routing_ref": "r_pin200"
        }
      ],
      "ship_via": "UPS Ground",
      "quote_ref": "q_apex_widgets",
      "contact_ref": "ct_apex_buy",
      "due_in_days": 6,
      "customer_ref": "c_apex",
      "freight_terms": "prepaid",
      "payment_terms": "Net 30",
      "created_days_ago": 40,
      "customer_po_number": "APX-77412",
      "billing_address_ref": "ad_apex_bill",
      "shipping_address_ref": "ad_apex_ship"
    },
    {
      "_ref": "j_helix_brackets",
      "parts": [
        {
          "_ref": "jp_helix_bracket",
          "part_ref": "p_bracket300",
          "quantity": 100,
          "sequence": 10,
          "operations": [
            {
              "days_ago": 16,
              "sequence": 10,
              "author_index": 1,
              "completed_quantity": 100
            },
            {
              "status": "completed",
              "days_ago": 6,
              "sequence": 20
            },
            {
              "note": "Inserts running slow, driver keeps stalling.",
              "days_ago": 2,
              "sequence": 30,
              "author_index": 2,
              "completed_quantity": 62
            }
          ],
          "unit_price": 62.0,
          "routing_ref": "r_bracket300"
        }
      ],
      "is_hot": true,
      "ship_via": "Customer carrier",
      "quote_ref": "q_helix_brackets",
      "contact_ref": "ct_helix_buy",
      "due_in_days": -2,
      "customer_ref": "c_helix",
      "freight_terms": "collect",
      "payment_terms": "Net 45",
      "created_days_ago": 34,
      "customer_po_number": "HLX-2026-0451",
      "billing_address_ref": "ad_helix_bill",
      "shipping_address_ref": "ad_helix_ship",
      "shipping_instructions": "Call Riley 24 hr before the truck."
    },
    {
      "_ref": "j_north_housings",
      "parts": [
        {
          "_ref": "jp_north_housing",
          "part_ref": "p_housing500",
          "quantity": 20,
          "sequence": 10,
          "operations": [
            {
              "days_ago": 8,
              "sequence": 10,
              "author_index": 1,
              "completed_quantity": 20
            },
            {
              "days_ago": 2,
              "sequence": 20,
              "author_index": 3,
              "completed_quantity": 12
            }
          ],
          "unit_price": 218.0,
          "routing_ref": "r_housing500"
        },
        {
          "_ref": "jp_north_cover",
          "part_ref": "p_cover900",
          "quantity": 20,
          "sequence": 20,
          "operations": [
            {
              "days_ago": 5,
              "sequence": 10,
              "author_index": 2,
              "completed_quantity": 20
            }
          ],
          "unit_price": 46.0,
          "routing_ref": "r_cover900"
        }
      ],
      "ship_via": "FedEx Ground",
      "quote_ref": "q_north_housings",
      "contact_ref": "ct_north_buy",
      "due_in_days": 18,
      "customer_ref": "c_north",
      "freight_terms": "prepaid",
      "payment_terms": "Net 30",
      "created_days_ago": 24,
      "customer_po_number": "NSM-90233",
      "billing_address_ref": "ad_north_bill",
      "shipping_address_ref": "ad_north_bill"
    },
    {
      "_ref": "j_cascade_manifolds",
      "parts": [
        {
          "_ref": "jp_cascade_manifold",
          "part_ref": "p_manifold600",
          "quantity": 10,
          "sequence": 10,
          "operations": [
            {
              "note": "Two hours a piece on the cross-drills. Slower than quoted.",
              "days_ago": 1,
              "sequence": 10,
              "author_index": 3,
              "completed_quantity": 4
            }
          ],
          "unit_price": 640.0,
          "routing_ref": "r_manifold600"
        }
      ],
      "ship_via": "UPS Ground",
      "quote_ref": "q_cascade_manifolds",
      "contact_ref": "ct_cascade_buy",
      "due_in_days": 26,
      "customer_ref": "c_cascade",
      "freight_terms": "prepaid",
      "payment_terms": "Net 30",
      "created_days_ago": 16,
      "customer_po_number": "CH-5580",
      "billing_address_ref": "ad_cascade_bill",
      "shipping_address_ref": "ad_cascade_bill"
    },
    {
      "_ref": "j_iron_shafts",
      "parts": [
        {
          "_ref": "jp_iron_shaft",
          "part_ref": "p_shaft400",
          "quantity": 30,
          "sequence": 10,
          "operations": [
            {
              "days_ago": 9,
              "sequence": 10,
              "author_index": 1,
              "completed_quantity": 30
            },
            {
              "status": "sent",
              "days_ago": 5,
              "sequence": 20
            }
          ],
          "unit_price": 196.0,
          "routing_ref": "r_shaft400"
        },
        {
          "_ref": "jp_iron_pin",
          "part_ref": "p_pin200",
          "quantity": 60,
          "sequence": 20,
          "unit_price": 36.75,
          "routing_ref": "r_pin200"
        }
      ],
      "ship_via": "Customer freight account",
      "quote_ref": "q_iron_shafts",
      "contact_ref": "ct_iron_buy",
      "due_in_days": 34,
      "customer_ref": "c_ironclad",
      "freight_terms": "third_party",
      "payment_terms": "Net 60",
      "created_days_ago": 20,
      "customer_po_number": "ICD-4400-77",
      "billing_address_ref": "ad_iron_bill",
      "shipping_address_ref": "ad_iron_ship"
    },
    {
      "_ref": "j_lake_valves",
      "parts": [
        {
          "_ref": "jp_lake_valve",
          "part_ref": "p_valve1100",
          "quantity": 20,
          "sequence": 10,
          "unit_price": 284.0,
          "routing_ref": "r_valve1100"
        },
        {
          "_ref": "jp_lake_flange",
          "part_ref": "p_flange700",
          "quantity": 40,
          "sequence": 20,
          "operations": [
            {
              "days_ago": 2,
              "sequence": 10,
              "author_index": 2,
              "completed_quantity": 40
            }
          ],
          "unit_price": 52.0,
          "routing_ref": "r_flange700"
        },
        {
          "_ref": "jp_lake_spacer",
          "part_ref": "p_spacer800",
          "quantity": 100,
          "sequence": 30,
          "unit_price": 8.4,
          "routing_ref": "r_spacer800"
        }
      ],
      "ship_via": "UPS Ground",
      "quote_ref": "q_lake_valves",
      "contact_ref": "ct_lake_buy",
      "due_in_days": 21,
      "customer_ref": "c_lakeshore",
      "freight_terms": "prepaid",
      "payment_terms": "Net 30",
      "created_days_ago": 9,
      "customer_po_number": "LPE-30119",
      "billing_address_ref": "ad_lake_bill",
      "shipping_address_ref": "ad_lake_bill"
    },
    {
      "_ref": "j_vertex_adapters",
      "parts": [
        {
          "_ref": "jp_vertex_adapter",
          "part_ref": "p_adapter1200",
          "quantity": 50,
          "sequence": 10,
          "unit_price": 74.0,
          "routing_ref": "r_adapter1200"
        },
        {
          "_ref": "jp_vertex_knob",
          "source": "bought",
          "part_ref": "p_bought_knob",
          "quantity": 100,
          "sequence": 20,
          "unit_price": 4.6
        }
      ],
      "ship_via": "FedEx Ground",
      "quote_ref": "q_vertex_adapters",
      "contact_ref": "ct_vertex_buy",
      "due_in_days": 16,
      "customer_ref": "c_vertex",
      "freight_terms": "prepaid",
      "payment_terms": "Net 30",
      "created_days_ago": 5,
      "customer_po_number": "VEC-8891",
      "billing_address_ref": "ad_vertex_bill",
      "shipping_address_ref": "ad_vertex_bill"
    },
    {
      "_ref": "j_apex_repeat",
      "parts": [
        {
          "_ref": "jp_apex_repeat_widget",
          "part_ref": "p_widget100",
          "quantity": 40,
          "sequence": 10,
          "operations": [
            {
              "days_ago": 60,
              "sequence": 10,
              "author_index": 1,
              "completed_quantity": 40
            },
            {
              "days_ago": 56,
              "sequence": 20,
              "author_index": 2,
              "completed_quantity": 40
            },
            {
              "status": "completed",
              "days_ago": 50,
              "sequence": 30
            },
            {
              "days_ago": 46,
              "sequence": 40,
              "author_index": 1,
              "completed_quantity": 40
            },
            {
              "days_ago": 44,
              "sequence": 50,
              "author_index": 3,
              "completed_quantity": 40
            }
          ],
          "unit_price": 138.0,
          "routing_ref": "r_widget100"
        }
      ],
      "ship_via": "UPS Ground",
      "contact_ref": "ct_apex_buy",
      "due_in_days": -30,
      "customer_ref": "c_apex",
      "freight_terms": "prepaid",
      "payment_terms": "Net 30",
      "created_days_ago": 72,
      "customer_po_number": "APX-76980",
      "billing_address_ref": "ad_apex_bill",
      "shipping_address_ref": "ad_apex_ship"
    },
    {
      "_ref": "j_helix_repeat",
      "parts": [
        {
          "_ref": "jp_helix_repeat_bracket",
          "part_ref": "p_bracket350",
          "quantity": 60,
          "sequence": 10,
          "operations": [
            {
              "days_ago": 55,
              "sequence": 10,
              "author_index": 2,
              "completed_quantity": 60
            },
            {
              "days_ago": 51,
              "sequence": 20,
              "author_index": 1,
              "completed_quantity": 60
            },
            {
              "status": "completed",
              "days_ago": 45,
              "sequence": 30
            },
            {
              "days_ago": 42,
              "sequence": 40,
              "author_index": 3,
              "completed_quantity": 60
            }
          ],
          "unit_price": 71.0,
          "routing_ref": "r_bracket350"
        }
      ],
      "contact_ref": "ct_helix_buy",
      "due_in_days": -24,
      "customer_ref": "c_helix",
      "freight_terms": "collect",
      "payment_terms": "Net 45",
      "created_days_ago": 64,
      "customer_po_number": "HLX-2026-0388",
      "billing_address_ref": "ad_helix_bill",
      "shipping_address_ref": "ad_helix_ship"
    },
    {
      "_ref": "j_north_repeat",
      "parts": [
        {
          "_ref": "jp_north_repeat_flange",
          "part_ref": "p_flange700",
          "quantity": 40,
          "sequence": 10,
          "operations": [
            {
              "days_ago": 48,
              "sequence": 10,
              "author_index": 1,
              "completed_quantity": 40
            },
            {
              "status": "completed",
              "days_ago": 42,
              "sequence": 20
            },
            {
              "days_ago": 40,
              "sequence": 30,
              "author_index": 2,
              "completed_quantity": 40
            }
          ],
          "unit_price": 54.0,
          "routing_ref": "r_flange700"
        }
      ],
      "contact_ref": "ct_north_buy",
      "due_in_days": -18,
      "customer_ref": "c_north",
      "freight_terms": "prepaid",
      "payment_terms": "Net 30",
      "created_days_ago": 55,
      "customer_po_number": "NSM-89877",
      "billing_address_ref": "ad_north_bill",
      "shipping_address_ref": "ad_north_bill"
    },
    {
      "_ref": "j_cascade_repeat",
      "parts": [
        {
          "_ref": "jp_cascade_repeat_spacer",
          "part_ref": "p_spacer800",
          "quantity": 200,
          "sequence": 10,
          "operations": [
            {
              "days_ago": 40,
              "sequence": 10,
              "author_index": 3,
              "completed_quantity": 200
            }
          ],
          "unit_price": 7.9,
          "routing_ref": "r_spacer800"
        },
        {
          "_ref": "jp_cascade_repeat_cover",
          "part_ref": "p_cover900",
          "quantity": 30,
          "sequence": 20,
          "operations": [
            {
              "days_ago": 39,
              "sequence": 10,
              "author_index": 1,
              "completed_quantity": 30
            },
            {
              "status": "completed",
              "days_ago": 34,
              "sequence": 20
            },
            {
              "days_ago": 32,
              "sequence": 30,
              "author_index": 2,
              "completed_quantity": 30
            }
          ],
          "unit_price": 44.0,
          "routing_ref": "r_cover900"
        }
      ],
      "contact_ref": "ct_cascade_buy",
      "due_in_days": -12,
      "customer_ref": "c_cascade",
      "freight_terms": "prepaid",
      "payment_terms": "Net 30",
      "created_days_ago": 47,
      "customer_po_number": "CH-5402",
      "billing_address_ref": "ad_cascade_bill",
      "shipping_address_ref": "ad_cascade_bill"
    },
    {
      "_ref": "j_lake_rollers",
      "parts": [
        {
          "_ref": "jp_lake_handle",
          "source": "bought",
          "part_ref": "p_bought_handle",
          "quantity": 40,
          "sequence": 10,
          "unit_price": 9.45
        }
      ],
      "contact_ref": "ct_lake_buy",
      "due_in_days": 24,
      "customer_ref": "c_lakeshore",
      "freight_terms": "prepaid",
      "payment_terms": "Net 30",
      "created_days_ago": 3,
      "customer_po_number": "LPE-30204",
      "billing_address_ref": "ad_lake_bill",
      "shipping_address_ref": "ad_lake_bill"
    },
    {
      "_ref": "j_vertex_plates",
      "parts": [
        {
          "_ref": "jp_vertex_plate",
          "part_ref": "p_sub_plate",
          "quantity": 40,
          "sequence": 10,
          "unit_price": 39.0,
          "routing_ref": "r_sub_plate"
        }
      ],
      "contact_ref": "ct_vertex_buy",
      "due_in_days": 30,
      "customer_ref": "c_vertex",
      "freight_terms": "prepaid",
      "payment_terms": "Net 30",
      "created_days_ago": 2,
      "customer_po_number": "VEC-8903",
      "billing_address_ref": "ad_vertex_bill",
      "shipping_address_ref": "ad_vertex_bill"
    },
    {
      "_ref": "j_iron_widget150",
      "parts": [
        {
          "_ref": "jp_iron_widget150",
          "part_ref": "p_widget150",
          "quantity": 25,
          "sequence": 10,
          "operations": [
            {
              "days_ago": 6,
              "sequence": 10,
              "author_index": 2,
              "completed_quantity": 25
            },
            {
              "note": "Fixture is walking, re-indicating every 4 parts.",
              "days_ago": 1,
              "sequence": 20,
              "author_index": 1,
              "completed_quantity": 11
            }
          ],
          "unit_price": 162.0,
          "routing_ref": "r_widget150"
        }
      ],
      "is_hot": true,
      "contact_ref": "ct_iron_buy",
      "due_in_days": 9,
      "customer_ref": "c_ironclad",
      "freight_terms": "third_party",
      "payment_terms": "Net 60",
      "created_days_ago": 11,
      "customer_po_number": "ICD-4400-91",
      "billing_address_ref": "ad_iron_bill",
      "shipping_address_ref": "ad_iron_ship",
      "shipping_instructions": "Certs required with shipment. No partials."
    },
    {
      "_ref": "j_summit_clamps",
      "parts": [
        {
          "_ref": "jp_summit_clamp",
          "part_ref": "p_clamp1400",
          "quantity": 60,
          "sequence": 10,
          "unit_price": 41.0,
          "routing_ref": "r_clamp1400"
        }
      ],
      "contact_ref": "ct_summit_buy",
      "due_in_days": 20,
      "customer_ref": "c_summit",
      "payment_terms": "Net 30",
      "created_days_ago": 6,
      "customer_po_number": "SAG-1174",
      "billing_address_ref": "ad_summit_bill",
      "shipping_address_ref": "ad_summit_bill"
    },
    {
      "_ref": "j_apex_gears",
      "parts": [
        {
          "_ref": "jp_apex_gear",
          "part_ref": "p_gear1000",
          "quantity": 25,
          "sequence": 10,
          "unit_price": 96.0,
          "routing_ref": "r_gear1000"
        },
        {
          "_ref": "jp_apex_plateassy",
          "part_ref": "p_plateassy",
          "quantity": 25,
          "sequence": 20,
          "unit_price": 118.0,
          "routing_ref": "r_plateassy"
        }
      ],
      "contact_ref": "ct_apex_buy",
      "due_in_days": 11,
      "customer_ref": "c_apex",
      "freight_terms": "prepaid",
      "payment_terms": "Net 30",
      "created_days_ago": 13,
      "customer_po_number": "APX-77501",
      "billing_address_ref": "ad_apex_bill",
      "shipping_address_ref": "ad_apex_ship"
    }
  ],
  "note": "Demo template v4. Rebuilt against the August 2026 schema (source/is_stocked parts, split job statuses, customer_contacts + customer_addresses, storage locations with per-location balances, procurement/pricing tiers, notes feed, shipments). v4 gives EVERY part a markup pricing tier: get_priceable_part_ids requires one, so the 31 parts v3 left without one were flagged 'Incomplete \u2014 needs setup before it can be quoted' on the Parts page. Markups are anchored to the real companies' distribution (every part carries a tier; median 25%). Roughly a 40-person-week of shop history for a 12-machine precision shop: 45 parts, 21 routings, 8 customers, 10 quotes, 16 jobs across every status, 6 shipments, 29 notes.",
  "notes": [
    {
      "body": "Print calls out 0.9995/0.9990 on the bore. Anything over 0.9993 and the o-ring will not seat \u2014 check every fifth part.",
      "job_ref": "j_apex_widgets",
      "days_ago": 10,
      "reactions": [
        {
          "kind": "helpful",
          "reactor_index": 2
        },
        {
          "kind": "helpful",
          "reactor_index": 0
        }
      ],
      "author_index": 1,
      "job_part_ref": "jp_apex_widget",
      "subject_kind": "job",
      "operation_sequence": 20
    },
    {
      "body": "Ten went out on the first truck, the rest go when assembly finishes. Morgan knows.",
      "job_ref": "j_apex_widgets",
      "days_ago": 1,
      "author_index": 0,
      "job_part_ref": "jp_apex_widget",
      "subject_kind": "job",
      "operation_sequence": 40
    },
    {
      "body": "Apex moved the need-by in a week. Not a new PO, just a phone call \u2014 confirmed with Morgan on the 2nd.",
      "job_ref": "j_apex_widgets",
      "days_ago": 5,
      "author_index": 0,
      "subject_kind": "job"
    },
    {
      "body": "Insert driver keeps stalling on the second hole. Slower feed fixes it. Roughly 3 minutes a part instead of 1.",
      "job_ref": "j_helix_brackets",
      "days_ago": 2,
      "reactions": [
        {
          "kind": "confirmed",
          "reactor_index": 1
        }
      ],
      "author_index": 2,
      "job_part_ref": "jp_helix_bracket",
      "subject_kind": "job",
      "operation_sequence": 30
    },
    {
      "body": "This one is late and Riley has called twice. Anodize came back on time, we lost the days at assembly.",
      "job_ref": "j_helix_brackets",
      "days_ago": 1,
      "author_index": 0,
      "subject_kind": "job"
    },
    {
      "body": "Cross-drills are taking about two hours a piece. We quoted 22 minutes of cycle. Worth a look before the next order.",
      "job_ref": "j_cascade_manifolds",
      "days_ago": 1,
      "reactions": [
        {
          "kind": "confirmed",
          "reactor_index": 0
        }
      ],
      "author_index": 3,
      "job_part_ref": "jp_cascade_manifold",
      "subject_kind": "job",
      "operation_sequence": 10
    },
    {
      "body": "Fixture is walking. Re-indicating every four parts until we get a proper stop made.",
      "job_ref": "j_iron_widget150",
      "days_ago": 1,
      "author_index": 1,
      "job_part_ref": "jp_iron_widget150",
      "subject_kind": "job",
      "operation_sequence": 20
    },
    {
      "body": "Ironclad needs certs in the box. No partial shipments on this PO.",
      "job_ref": "j_iron_widget150",
      "days_ago": 10,
      "author_index": 0,
      "subject_kind": "job"
    },
    {
      "body": "Groove depth is the whole part on these. Every one gets scoped, not a sample.",
      "job_ref": "j_north_housings",
      "days_ago": 3,
      "author_index": 3,
      "job_part_ref": "jp_north_housing",
      "subject_kind": "job",
      "operation_sequence": 20
    },
    {
      "body": "Summit is on credit hold. Do not release to the floor until accounting clears the check.",
      "job_ref": "j_summit_clamps",
      "days_ago": 6,
      "reactions": [
        {
          "kind": "helpful",
          "reactor_index": 1
        }
      ],
      "author_index": 0,
      "subject_kind": "job"
    },
    {
      "body": "304 work-hardens fast. Keep the feed up and do not dwell.",
      "job_ref": "j_lake_valves",
      "days_ago": 2,
      "author_index": 2,
      "job_part_ref": "jp_lake_flange",
      "subject_kind": "job",
      "operation_sequence": 10
    },
    {
      "body": "Shipped complete on the 40. Clean run start to finish \u2014 use this one as the reference next time we quote WIDGET-100.",
      "job_ref": "j_apex_repeat",
      "days_ago": 42,
      "reactions": [
        {
          "kind": "helpful",
          "reactor_index": 2
        }
      ],
      "author_index": 0,
      "subject_kind": "job"
    },
    {
      "body": "Standard setup lives in the blue binder, tab 4. Soft jaws are in the drawer under the Mazak, labelled W-100.",
      "days_ago": 30,
      "part_ref": "p_widget100",
      "reactions": [
        {
          "kind": "helpful",
          "reactor_index": 2
        },
        {
          "kind": "helpful",
          "reactor_index": 3
        }
      ],
      "author_index": 1,
      "subject_kind": "part"
    },
    {
      "body": "Anodize masks the bore. If it comes back with colour in the bore it is a reject, not a rework.",
      "days_ago": 22,
      "part_ref": "p_widget100",
      "author_index": 3,
      "subject_kind": "part"
    },
    {
      "body": "Deburring the port intersections is most of the labour on this part. Scope every one, a missed burr comes back as a warranty claim.",
      "days_ago": 18,
      "part_ref": "p_manifold600",
      "reactions": [
        {
          "kind": "confirmed",
          "reactor_index": 1
        }
      ],
      "author_index": 3,
      "subject_kind": "part"
    },
    {
      "body": "Run Delrin dry. Coolant swells it and the OD reads 0.002 big an hour later.",
      "days_ago": 26,
      "part_ref": "p_spacer800",
      "reactions": [
        {
          "kind": "helpful",
          "reactor_index": 0
        }
      ],
      "author_index": 2,
      "subject_kind": "part"
    },
    {
      "body": "EDM keyway goes out before heat treat, never after. We learned that the expensive way in March.",
      "days_ago": 35,
      "part_ref": "p_pin200",
      "author_index": 1,
      "subject_kind": "part"
    },
    {
      "body": "Last two bundles from Midwest ran hard on the saw. Blade life is about half what we normally see.",
      "days_ago": 14,
      "part_ref": "p_bar4140",
      "author_index": 2,
      "subject_kind": "part"
    },
    {
      "body": "Fixture for op 2 is in the rack by the VF-4. It is marked H-500 rev B \u2014 rev A is scrapped, do not use it.",
      "days_ago": 20,
      "part_ref": "p_housing500",
      "author_index": 1,
      "subject_kind": "part"
    },
    {
      "body": "303 chips nest badly in the sub-spindle. Peck the deep hole or you will be picking it out.",
      "days_ago": 9,
      "part_ref": "p_valve1100",
      "author_index": 2,
      "subject_kind": "part"
    },
    {
      "body": "We keep about 60 of these on Shelf 1-A. Below 20 is when we start a new batch of 25.",
      "days_ago": 45,
      "part_ref": "p_sub_blank",
      "author_index": 0,
      "subject_kind": "part"
    },
    {
      "_ref": "n_mill1_noticed",
      "body": "Way oil is weeping at the front of the X axis. Small puddle by the end of the shift.",
      "days_ago": 16,
      "reactions": [
        {
          "kind": "confirmed",
          "reactor_index": 1
        }
      ],
      "author_index": 2,
      "subject_kind": "work_center",
      "work_center_ref": "wc_mill1",
      "maintenance_kind": "noticed"
    },
    {
      "body": "Replaced the X-axis way wiper and topped up the lube reservoir. Dry after two days of running.",
      "days_ago": 12,
      "author_index": 1,
      "resolves_ref": "n_mill1_noticed",
      "subject_kind": "work_center",
      "work_center_ref": "wc_mill1",
      "maintenance_kind": "repaired"
    },
    {
      "_ref": "n_lathe1_noticed",
      "body": "Chip conveyor jams about once a shift on long stringy stock. Clears by hand.",
      "days_ago": 8,
      "author_index": 1,
      "subject_kind": "work_center",
      "work_center_ref": "wc_lathe1",
      "maintenance_kind": "noticed"
    },
    {
      "body": "Pulled and cleaned the coolant tank. It was well past due.",
      "days_ago": 5,
      "author_index": 2,
      "subject_kind": "work_center",
      "work_center_ref": "wc_lathe2",
      "maintenance_kind": "cleaned"
    },
    {
      "body": "Re-tuned the 4th axis brake pressure. Was slipping on heavy cuts in 7075.",
      "days_ago": 11,
      "author_index": 3,
      "subject_kind": "work_center",
      "work_center_ref": "wc_mill2",
      "maintenance_kind": "adjusted"
    },
    {
      "body": "New blade fitted. Old one had maybe 40 cuts left in it, not worth the risk on the 4140.",
      "days_ago": 3,
      "author_index": 2,
      "subject_kind": "work_center",
      "work_center_ref": "wc_saw",
      "maintenance_kind": "replaced"
    },
    {
      "body": "CMM calibration is due next month. Certificate is in the office file, expires on the 12th.",
      "days_ago": 7,
      "reactions": [
        {
          "kind": "helpful",
          "reactor_index": 0
        }
      ],
      "author_index": 3,
      "subject_kind": "work_center",
      "work_center_ref": "wc_qc"
    },
    {
      "body": "Bridgeport is the one to use for one-off fixtures. Do not tie up the VMCs for a soft jaw.",
      "days_ago": 28,
      "author_index": 0,
      "subject_kind": "work_center",
      "work_center_ref": "wc_mill3"
    }
  ],
  "parts": [
    {
      "_ref": "p_bar1018_1",
      "stock": [
        {
          "quantity": 864,
          "location_ref": "loc_raw_a"
        },
        {
          "quantity": 288,
          "location_ref": "loc_raw_b"
        }
      ],
      "source": "bought",
      "part_name": "1018-BAR-1.000",
      "is_stocked": true,
      "description": "1018 cold-rolled steel bar, 1.000 in dia, 12 ft sticks",
      "primary_unit": "in",
      "reorder_point": 240,
      "unit_conversions": [
        {
          "from_unit": "stick",
          "to_primary_factor": 144
        }
      ],
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 0.92,
          "expires_in_days": 50,
          "quoted_days_ago": 40
        },
        {
          "notes": "Full-bundle price",
          "min_quantity": 720,
          "cost_per_unit": 0.81,
          "expires_in_days": 50,
          "quoted_days_ago": 40
        }
      ],
      "preferred_vendor_ref": "v_steel",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 25
        },
        {
          "sequence": 20,
          "quantity": 720,
          "markup_percent": 20
        }
      ]
    },
    {
      "_ref": "p_bar1018_075",
      "stock": [
        {
          "quantity": 576,
          "location_ref": "loc_raw_a"
        }
      ],
      "source": "bought",
      "part_name": "1018-BAR-0.750",
      "is_stocked": true,
      "description": "1018 cold-rolled steel bar, 0.750 in dia",
      "primary_unit": "in",
      "reorder_point": 200,
      "unit_conversions": [
        {
          "from_unit": "stick",
          "to_primary_factor": 144
        }
      ],
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 0.64,
          "expires_in_days": 50,
          "quoted_days_ago": 40
        }
      ],
      "preferred_vendor_ref": "v_steel",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 25
        }
      ]
    },
    {
      "_ref": "p_bar4140",
      "stock": [
        {
          "quantity": 432,
          "location_ref": "loc_raw_b"
        }
      ],
      "source": "bought",
      "part_name": "4140-BAR-1.250",
      "is_stocked": true,
      "description": "4140 pre-hard alloy bar, 1.250 in dia",
      "primary_unit": "in",
      "reorder_point": 180,
      "unit_conversions": [
        {
          "from_unit": "stick",
          "to_primary_factor": 144
        }
      ],
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 1.85,
          "expires_in_days": 65,
          "quoted_days_ago": 25
        }
      ],
      "preferred_vendor_ref": "v_steel",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 25
        }
      ]
    },
    {
      "_ref": "p_bar303",
      "stock": [
        {
          "quantity": 288,
          "location_ref": "loc_raw_b"
        }
      ],
      "source": "bought",
      "part_name": "303-BAR-0.625",
      "is_stocked": true,
      "description": "303 stainless bar, 0.625 in dia, free-machining",
      "primary_unit": "in",
      "reorder_point": 150,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 2.4,
          "expires_in_days": 65,
          "quoted_days_ago": 25
        }
      ],
      "preferred_vendor_ref": "v_steel",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 28
        }
      ]
    },
    {
      "_ref": "p_plate6061_25",
      "stock": [
        {
          "quantity": 2880,
          "location_ref": "loc_raw_c"
        }
      ],
      "source": "bought",
      "part_name": "6061-PLATE-0.250",
      "is_stocked": true,
      "description": "6061-T6 aluminum plate, 0.250 in thick",
      "primary_unit": "sqin",
      "reorder_point": 600,
      "unit_conversions": [
        {
          "from_unit": "sheet",
          "to_primary_factor": 1728
        }
      ],
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 0.14,
          "expires_in_days": 72,
          "quoted_days_ago": 18
        },
        {
          "notes": "Full sheet",
          "min_quantity": 1728,
          "cost_per_unit": 0.115,
          "expires_in_days": 72,
          "quoted_days_ago": 18
        }
      ],
      "preferred_vendor_ref": "v_alloy",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 25
        },
        {
          "sequence": 20,
          "quantity": 1728,
          "markup_percent": 20
        }
      ]
    },
    {
      "_ref": "p_plate6061_50",
      "stock": [
        {
          "quantity": 1440,
          "location_ref": "loc_raw_c"
        }
      ],
      "source": "bought",
      "part_name": "6061-PLATE-0.500",
      "is_stocked": true,
      "description": "6061-T6 aluminum plate, 0.500 in thick",
      "primary_unit": "sqin",
      "reorder_point": 400,
      "unit_conversions": [
        {
          "from_unit": "sheet",
          "to_primary_factor": 1728
        }
      ],
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 0.26,
          "expires_in_days": 72,
          "quoted_days_ago": 18
        }
      ],
      "preferred_vendor_ref": "v_alloy",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 25
        }
      ]
    },
    {
      "_ref": "p_plate7075",
      "stock": [
        {
          "quantity": 864,
          "location_ref": "loc_raw_c"
        }
      ],
      "source": "bought",
      "part_name": "7075-PLATE-0.375",
      "is_stocked": true,
      "description": "7075-T651 aluminum plate, 0.375 in thick",
      "primary_unit": "sqin",
      "reorder_point": 300,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 0.48,
          "expires_in_days": 78,
          "quoted_days_ago": 12
        }
      ],
      "preferred_vendor_ref": "v_alloy",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 28
        }
      ]
    },
    {
      "_ref": "p_sheet304",
      "stock": [
        {
          "quantity": 1152,
          "location_ref": "loc_raw_c"
        }
      ],
      "source": "bought",
      "part_name": "304-SHEET-0.125",
      "is_stocked": true,
      "description": "304 stainless sheet, 0.125 in thick",
      "primary_unit": "sqin",
      "reorder_point": 400,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 0.31,
          "expires_in_days": 78,
          "quoted_days_ago": 12
        }
      ],
      "preferred_vendor_ref": "v_alloy",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 28
        }
      ]
    },
    {
      "_ref": "p_tube6061",
      "stock": [
        {
          "quantity": 288,
          "location_ref": "loc_raw_a"
        }
      ],
      "source": "bought",
      "part_name": "6061-TUBE-2.00OD",
      "is_stocked": true,
      "description": "6061 aluminum round tube, 2.00 in OD x 0.125 wall",
      "primary_unit": "in",
      "reorder_point": 120,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 1.1,
          "expires_in_days": 60,
          "quoted_days_ago": 30
        }
      ],
      "preferred_vendor_ref": "v_alloy",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 25
        }
      ]
    },
    {
      "_ref": "p_delrin",
      "stock": [
        {
          "quantity": 216,
          "location_ref": "loc_raw_b"
        }
      ],
      "source": "bought",
      "part_name": "DELRIN-BAR-1.500",
      "is_stocked": true,
      "description": "Delrin acetal bar, 1.500 in dia, natural",
      "primary_unit": "in",
      "reorder_point": 96,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 0.72,
          "expires_in_days": 35,
          "quoted_days_ago": 55
        }
      ],
      "preferred_vendor_ref": "v_alloy",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 30
        }
      ]
    },
    {
      "_ref": "p_shcs14",
      "stock": [
        {
          "quantity": 1400,
          "location_ref": "loc_hw_1"
        }
      ],
      "source": "bought",
      "part_name": "SHCS-0.250-20X1.00",
      "is_stocked": true,
      "description": "Socket head cap screw, 1/4-20 x 1.00, black oxide",
      "primary_unit": "each",
      "reorder_point": 250,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 0.22,
          "expires_in_days": 30,
          "quoted_days_ago": 60
        },
        {
          "min_quantity": 1000,
          "cost_per_unit": 0.16,
          "expires_in_days": 30,
          "quoted_days_ago": 60
        }
      ],
      "preferred_vendor_ref": "v_fast",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 35
        },
        {
          "sequence": 20,
          "quantity": 1000,
          "markup_percent": 28
        }
      ]
    },
    {
      "_ref": "p_shcs10",
      "stock": [
        {
          "quantity": 960,
          "location_ref": "loc_hw_1"
        }
      ],
      "source": "bought",
      "part_name": "SHCS-10-32X0.75",
      "is_stocked": true,
      "description": "Socket head cap screw, 10-32 x 0.75, stainless",
      "primary_unit": "each",
      "reorder_point": 200,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 0.18,
          "expires_in_days": 30,
          "quoted_days_ago": 60
        }
      ],
      "preferred_vendor_ref": "v_fast",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 35
        }
      ]
    },
    {
      "_ref": "p_dowel",
      "stock": [
        {
          "quantity": 620,
          "location_ref": "loc_hw_2"
        }
      ],
      "source": "bought",
      "part_name": "DOWEL-0.250X1.00",
      "is_stocked": true,
      "description": "Hardened dowel pin, 0.2500 x 1.00",
      "primary_unit": "each",
      "reorder_point": 150,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 0.34,
          "expires_in_days": 30,
          "quoted_days_ago": 60
        }
      ],
      "preferred_vendor_ref": "v_fast",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 35
        }
      ]
    },
    {
      "_ref": "p_oring",
      "stock": [
        {
          "quantity": 880,
          "location_ref": "loc_hw_2"
        }
      ],
      "source": "bought",
      "part_name": "ORING-2-014",
      "is_stocked": true,
      "description": "O-ring, Buna-N 70A, AS568-014",
      "primary_unit": "each",
      "reorder_point": 200,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 0.11,
          "expires_in_days": 30,
          "quoted_days_ago": 60
        }
      ],
      "preferred_vendor_ref": "v_fast",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 40
        }
      ]
    },
    {
      "_ref": "p_bushing",
      "stock": [
        {
          "quantity": 240,
          "location_ref": "loc_hw_2"
        }
      ],
      "source": "bought",
      "part_name": "BUSHING-OIL-0.500",
      "is_stocked": true,
      "description": "Oil-impregnated bronze bushing, 0.500 ID",
      "primary_unit": "each",
      "reorder_point": 80,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 1.45,
          "expires_in_days": 45,
          "quoted_days_ago": 45
        }
      ],
      "preferred_vendor_ref": "v_fast",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 32
        }
      ]
    },
    {
      "_ref": "p_springpin",
      "stock": [
        {
          "quantity": 540,
          "location_ref": "loc_hw_3"
        }
      ],
      "source": "bought",
      "part_name": "SPRING-PIN-0.125",
      "is_stocked": true,
      "description": "Slotted spring pin, 0.125 x 0.750",
      "primary_unit": "each",
      "reorder_point": 150,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 0.09,
          "expires_in_days": 45,
          "quoted_days_ago": 45
        }
      ],
      "preferred_vendor_ref": "v_fast",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 40
        }
      ]
    },
    {
      "_ref": "p_insert",
      "stock": [
        {
          "quantity": 310,
          "location_ref": "loc_hw_3"
        }
      ],
      "source": "bought",
      "part_name": "THREADINSERT-0.250-20",
      "is_stocked": true,
      "description": "Helical thread insert, 1/4-20 x 1.5D",
      "primary_unit": "each",
      "reorder_point": 100,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 0.55,
          "expires_in_days": 45,
          "quoted_days_ago": 45
        }
      ],
      "preferred_vendor_ref": "v_fast",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 35
        }
      ]
    },
    {
      "_ref": "p_washer",
      "stock": [
        {
          "quantity": 1250,
          "location_ref": "loc_hw_3"
        }
      ],
      "source": "bought",
      "part_name": "WASHER-FLAT-0.250",
      "is_stocked": true,
      "description": "Flat washer, 1/4, stainless",
      "primary_unit": "each",
      "reorder_point": 200,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 0.04,
          "expires_in_days": 45,
          "quoted_days_ago": 45
        }
      ],
      "preferred_vendor_ref": "v_fast",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 40
        }
      ]
    },
    {
      "_ref": "p_coolant",
      "stock": [
        {
          "quantity": 25,
          "location_ref": "loc_crib"
        }
      ],
      "source": "bought",
      "part_name": "COOLANT-CONC-5GAL",
      "is_stocked": true,
      "description": "Semi-synthetic coolant concentrate, 5 gal pail",
      "primary_unit": "gal",
      "reorder_point": 10,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 38.5,
          "expires_in_days": 20,
          "quoted_days_ago": 70
        }
      ],
      "preferred_vendor_ref": "v_fast",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 20
        }
      ]
    },
    {
      "_ref": "p_endmill",
      "stock": [
        {
          "quantity": 14,
          "location_ref": "loc_crib"
        }
      ],
      "source": "bought",
      "part_name": "ENDMILL-0.500-4FL",
      "is_stocked": true,
      "description": "0.500 in 4-flute carbide end mill, AlTiN",
      "primary_unit": "each",
      "reorder_point": 6,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 42.0,
          "expires_in_days": 20,
          "quoted_days_ago": 70
        }
      ],
      "preferred_vendor_ref": "v_fast",
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 22
        }
      ]
    },
    {
      "_ref": "p_sub_blank",
      "stock": [
        {
          "quantity": 62,
          "location_ref": "loc_shelf1_a"
        }
      ],
      "source": "made",
      "part_name": "SUB-BLANK-001",
      "is_stocked": true,
      "description": "Turned blank for WIDGET-100 family",
      "primary_unit": "each",
      "reorder_point": 20,
      "costing_batch_quantity": 25,
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 42
        },
        {
          "sequence": 20,
          "quantity": 25,
          "markup_percent": 34
        }
      ]
    },
    {
      "_ref": "p_sub_bracket",
      "stock": [
        {
          "quantity": 48,
          "location_ref": "loc_shelf1_a"
        }
      ],
      "source": "made",
      "part_name": "SUB-BRACKET-002",
      "is_stocked": true,
      "description": "Milled bracket sub-assembly for BRACKET-300",
      "primary_unit": "each",
      "reorder_point": 24,
      "costing_batch_quantity": 50,
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 42
        },
        {
          "sequence": 20,
          "quantity": 50,
          "markup_percent": 34
        }
      ]
    },
    {
      "_ref": "p_sub_shaft",
      "stock": [
        {
          "quantity": 34,
          "location_ref": "loc_shelf1_b"
        }
      ],
      "source": "made",
      "part_name": "SUB-SHAFT-003",
      "is_stocked": true,
      "description": "Rough-turned shaft blank, pre heat-treat",
      "primary_unit": "each",
      "reorder_point": 15,
      "costing_batch_quantity": 30,
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 45
        }
      ]
    },
    {
      "_ref": "p_sub_housing",
      "stock": [
        {
          "quantity": 22,
          "location_ref": "loc_shelf1_b"
        }
      ],
      "source": "made",
      "part_name": "SUB-HOUSING-004",
      "is_stocked": true,
      "description": "Housing body, second-op ready",
      "primary_unit": "each",
      "reorder_point": 10,
      "costing_batch_quantity": 20,
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 45
        }
      ]
    },
    {
      "_ref": "p_sub_plate",
      "stock": [
        {
          "quantity": 55,
          "location_ref": "loc_shelf1_c"
        }
      ],
      "source": "made",
      "part_name": "SUB-PLATE-005",
      "is_stocked": true,
      "description": "Waterjet-profile plate blank, milled flat",
      "primary_unit": "each",
      "reorder_point": 20,
      "costing_batch_quantity": 40,
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 40
        }
      ]
    },
    {
      "_ref": "p_widget100",
      "source": "made",
      "part_name": "WIDGET-100",
      "is_stocked": false,
      "description": "Finished widget assembly, anodized",
      "primary_unit": "each",
      "pricing_tiers": [
        {
          "quantity": 1,
          "sequence": 10,
          "markup_percent": 65
        },
        {
          "quantity": 25,
          "sequence": 20,
          "markup_percent": 48
        },
        {
          "quantity": 100,
          "sequence": 30,
          "markup_percent": 38
        }
      ],
      "costing_batch_quantity": 25
    },
    {
      "_ref": "p_widget150",
      "source": "made",
      "part_name": "WIDGET-150",
      "is_stocked": false,
      "description": "Widget assembly, extended body variant",
      "primary_unit": "each",
      "pricing_tiers": [
        {
          "quantity": 1,
          "sequence": 10,
          "markup_percent": 65
        },
        {
          "quantity": 25,
          "sequence": 20,
          "markup_percent": 50
        }
      ],
      "costing_batch_quantity": 25
    },
    {
      "_ref": "p_bracket300",
      "source": "made",
      "part_name": "BRACKET-300",
      "is_stocked": false,
      "description": "Mounting bracket, black anodized",
      "primary_unit": "each",
      "pricing_tiers": [
        {
          "quantity": 1,
          "sequence": 10,
          "markup_percent": 60
        },
        {
          "quantity": 50,
          "sequence": 20,
          "markup_percent": 42
        },
        {
          "quantity": 250,
          "sequence": 30,
          "markup_percent": 33
        }
      ],
      "costing_batch_quantity": 50
    },
    {
      "_ref": "p_bracket350",
      "source": "made",
      "part_name": "BRACKET-350",
      "is_stocked": false,
      "description": "Mounting bracket, heavy-duty variant",
      "primary_unit": "each",
      "pricing_tiers": [
        {
          "quantity": 1,
          "sequence": 10,
          "markup_percent": 60
        },
        {
          "quantity": 50,
          "sequence": 20,
          "markup_percent": 44
        }
      ],
      "costing_batch_quantity": 50
    },
    {
      "_ref": "p_pin200",
      "source": "made",
      "part_name": "PIN-200",
      "is_stocked": false,
      "description": "Hardened locating pin with EDM keyway",
      "primary_unit": "each",
      "pricing_tiers": [
        {
          "quantity": 1,
          "sequence": 10,
          "markup_percent": 70
        },
        {
          "quantity": 50,
          "sequence": 20,
          "markup_percent": 52
        }
      ],
      "costing_batch_quantity": 50
    },
    {
      "_ref": "p_shaft400",
      "source": "made",
      "part_name": "SHAFT-400",
      "is_stocked": false,
      "description": "Drive shaft, through-hardened and ground",
      "primary_unit": "each",
      "pricing_tiers": [
        {
          "quantity": 1,
          "sequence": 10,
          "markup_percent": 62
        },
        {
          "quantity": 30,
          "sequence": 20,
          "markup_percent": 45
        }
      ],
      "costing_batch_quantity": 30
    },
    {
      "_ref": "p_housing500",
      "source": "made",
      "part_name": "HOUSING-500",
      "is_stocked": false,
      "description": "Pump housing, 6061, o-ring groove",
      "primary_unit": "each",
      "pricing_tiers": [
        {
          "quantity": 1,
          "sequence": 10,
          "markup_percent": 58
        },
        {
          "quantity": 20,
          "sequence": 20,
          "markup_percent": 44
        }
      ],
      "costing_batch_quantity": 20
    },
    {
      "_ref": "p_manifold600",
      "source": "made",
      "part_name": "MANIFOLD-600",
      "is_stocked": false,
      "description": "Hydraulic manifold block, 7075",
      "primary_unit": "each",
      "pricing_tiers": [
        {
          "quantity": 1,
          "sequence": 10,
          "markup_percent": 55
        },
        {
          "quantity": 10,
          "sequence": 20,
          "markup_percent": 42
        }
      ],
      "costing_batch_quantity": 10
    },
    {
      "_ref": "p_flange700",
      "source": "made",
      "part_name": "FLANGE-700",
      "is_stocked": false,
      "description": "Stainless mounting flange, 304",
      "primary_unit": "each",
      "pricing_tiers": [
        {
          "quantity": 1,
          "sequence": 10,
          "markup_percent": 60
        },
        {
          "quantity": 40,
          "sequence": 20,
          "markup_percent": 45
        }
      ],
      "costing_batch_quantity": 40
    },
    {
      "_ref": "p_spacer800",
      "source": "made",
      "part_name": "SPACER-800",
      "is_stocked": false,
      "description": "Precision spacer, Delrin",
      "primary_unit": "each",
      "pricing_tiers": [
        {
          "quantity": 1,
          "sequence": 10,
          "markup_percent": 75
        },
        {
          "quantity": 100,
          "sequence": 20,
          "markup_percent": 50
        }
      ],
      "costing_batch_quantity": 100
    },
    {
      "_ref": "p_cover900",
      "source": "made",
      "part_name": "COVER-900",
      "is_stocked": false,
      "description": "Access cover, 6061, anodized clear",
      "primary_unit": "each",
      "costing_batch_quantity": 50,
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 55
        },
        {
          "sequence": 20,
          "quantity": 50,
          "markup_percent": 40
        }
      ]
    },
    {
      "_ref": "p_gear1000",
      "source": "made",
      "part_name": "GEAR-BLANK-1000",
      "is_stocked": false,
      "description": "Gear blank, 4140, pre-hobbing",
      "primary_unit": "each",
      "costing_batch_quantity": 25,
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 52
        },
        {
          "sequence": 20,
          "quantity": 25,
          "markup_percent": 40
        }
      ]
    },
    {
      "_ref": "p_valve1100",
      "source": "made",
      "part_name": "VALVE-BODY-1100",
      "is_stocked": false,
      "description": "Valve body, 303 stainless",
      "primary_unit": "each",
      "pricing_tiers": [
        {
          "quantity": 1,
          "sequence": 10,
          "markup_percent": 58
        },
        {
          "quantity": 20,
          "sequence": 20,
          "markup_percent": 44
        }
      ],
      "costing_batch_quantity": 20
    },
    {
      "_ref": "p_adapter1200",
      "source": "made",
      "part_name": "ADAPTER-1200",
      "is_stocked": false,
      "description": "Tube adapter, 6061, both ends threaded",
      "primary_unit": "each",
      "pricing_tiers": [
        {
          "quantity": 1,
          "sequence": 10,
          "markup_percent": 64
        },
        {
          "quantity": 50,
          "sequence": 20,
          "markup_percent": 46
        }
      ],
      "costing_batch_quantity": 50
    },
    {
      "_ref": "p_roller1300",
      "source": "made",
      "part_name": "ROLLER-1300",
      "is_stocked": false,
      "description": "Conveyor roller shaft with bushings",
      "primary_unit": "each",
      "costing_batch_quantity": 40,
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 55
        },
        {
          "sequence": 20,
          "quantity": 40,
          "markup_percent": 42
        }
      ]
    },
    {
      "_ref": "p_clamp1400",
      "source": "made",
      "part_name": "CLAMP-1400",
      "is_stocked": false,
      "description": "Toggle clamp body, 1018",
      "primary_unit": "each",
      "costing_batch_quantity": 60,
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 58
        },
        {
          "sequence": 20,
          "quantity": 60,
          "markup_percent": 44
        }
      ]
    },
    {
      "_ref": "p_plateassy",
      "source": "made",
      "part_name": "PLATE-ASSY-1500",
      "is_stocked": false,
      "description": "Plate assembly with inserts and dowels",
      "primary_unit": "each",
      "costing_batch_quantity": 25,
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 52
        },
        {
          "sequence": 20,
          "quantity": 25,
          "markup_percent": 41
        }
      ]
    },
    {
      "_ref": "p_shim1600",
      "source": "made",
      "part_name": "SHIM-1600",
      "is_stocked": false,
      "description": "Laminated shim, 304, 0.125 stack",
      "primary_unit": "each",
      "costing_batch_quantity": 100,
      "pricing_tiers": [
        {
          "sequence": 10,
          "quantity": 1,
          "markup_percent": 60
        },
        {
          "sequence": 20,
          "quantity": 100,
          "markup_percent": 45
        }
      ]
    },
    {
      "_ref": "p_bought_knob",
      "stock": [
        {
          "quantity": 120,
          "location_ref": "loc_shelf2_a"
        }
      ],
      "source": "bought",
      "part_name": "KNOB-STAR-M8",
      "is_stocked": true,
      "description": "Star knob, M8 threaded insert \u2014 resold as-is",
      "primary_unit": "each",
      "pricing_tiers": [
        {
          "quantity": 1,
          "sequence": 10,
          "markup_percent": 80
        },
        {
          "quantity": 100,
          "sequence": 20,
          "markup_percent": 55
        }
      ],
      "reorder_point": 40,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 3.1,
          "expires_in_days": 70,
          "quoted_days_ago": 20
        },
        {
          "min_quantity": 100,
          "cost_per_unit": 2.55,
          "expires_in_days": 70,
          "quoted_days_ago": 20
        }
      ],
      "preferred_vendor_ref": "v_fast"
    },
    {
      "_ref": "p_bought_handle",
      "stock": [
        {
          "quantity": 75,
          "location_ref": "loc_shelf2_a"
        }
      ],
      "source": "bought",
      "part_name": "HANDLE-REVOLVING-90",
      "is_stocked": true,
      "description": "Revolving handle, 90 mm \u2014 resold as-is",
      "primary_unit": "each",
      "pricing_tiers": [
        {
          "quantity": 1,
          "sequence": 10,
          "markup_percent": 75
        }
      ],
      "reorder_point": 25,
      "procurement_tiers": [
        {
          "min_quantity": 1,
          "cost_per_unit": 5.4,
          "expires_in_days": 70,
          "quoted_days_ago": 20
        }
      ],
      "preferred_vendor_ref": "v_fast"
    }
  ],
  "quotes": [
    {
      "_ref": "q_apex_widgets",
      "status": "active",
      "fob_point": "Origin",
      "line_items": [
        {
          "part_ref": "p_widget100",
          "quantity": 25,
          "sequence": 10,
          "unit_price": 145.0,
          "markup_percent": 48,
          "base_cost_per_unit": 97.97
        },
        {
          "part_ref": "p_pin200",
          "quantity": 50,
          "sequence": 20,
          "unit_price": 38.5,
          "markup_percent": 52,
          "base_cost_per_unit": 25.33
        }
      ],
      "contact_ref": "ct_apex_buy",
      "customer_ref": "c_apex",
      "payment_terms": "Net 30",
      "lead_time_text": "3-4 weeks ARO",
      "expires_in_days": 14,
      "created_days_ago": 46,
      "billing_address_ref": "ad_apex_bill",
      "shipping_address_ref": "ad_apex_ship"
    },
    {
      "_ref": "q_helix_brackets",
      "status": "active",
      "fob_point": "Destination",
      "line_items": [
        {
          "part_ref": "p_bracket300",
          "quantity": 100,
          "sequence": 10,
          "unit_price": 62.0,
          "markup_percent": 42,
          "base_cost_per_unit": 43.66
        }
      ],
      "contact_ref": "ct_helix_buy",
      "customer_ref": "c_helix",
      "payment_terms": "Net 45",
      "lead_time_text": "2 weeks ARO",
      "expires_in_days": 22,
      "created_days_ago": 38,
      "billing_address_ref": "ad_helix_bill",
      "shipping_address_ref": "ad_helix_ship"
    },
    {
      "_ref": "q_north_housings",
      "status": "active",
      "fob_point": "Origin",
      "line_items": [
        {
          "part_ref": "p_housing500",
          "quantity": 20,
          "sequence": 10,
          "unit_price": 218.0,
          "markup_percent": 44,
          "base_cost_per_unit": 151.39
        },
        {
          "part_ref": "p_cover900",
          "quantity": 20,
          "sequence": 20,
          "unit_price": 46.0
        }
      ],
      "contact_ref": "ct_north_buy",
      "customer_ref": "c_north",
      "payment_terms": "Net 30",
      "lead_time_text": "5 weeks ARO, first article at week 3",
      "expires_in_days": 30,
      "created_days_ago": 30,
      "billing_address_ref": "ad_north_bill"
    },
    {
      "_ref": "q_cascade_manifolds",
      "status": "active",
      "fob_point": "Origin",
      "line_items": [
        {
          "part_ref": "p_manifold600",
          "quantity": 10,
          "sequence": 10,
          "unit_price": 640.0,
          "markup_percent": 42,
          "base_cost_per_unit": 450.7
        }
      ],
      "contact_ref": "ct_cascade_buy",
      "customer_ref": "c_cascade",
      "payment_terms": "Net 30",
      "lead_time_text": "6 weeks ARO",
      "expires_in_days": 39,
      "created_days_ago": 21,
      "billing_address_ref": "ad_cascade_bill"
    },
    {
      "_ref": "q_iron_shafts",
      "status": "active",
      "fob_point": "Destination",
      "line_items": [
        {
          "part_ref": "p_shaft400",
          "quantity": 30,
          "sequence": 10,
          "unit_price": 196.0,
          "markup_percent": 45,
          "base_cost_per_unit": 135.17
        },
        {
          "part_ref": "p_pin200",
          "quantity": 60,
          "sequence": 20,
          "unit_price": 36.75
        }
      ],
      "contact_ref": "ct_iron_buy",
      "customer_ref": "c_ironclad",
      "payment_terms": "Net 60",
      "lead_time_text": "8 weeks ARO",
      "expires_in_days": 34,
      "created_days_ago": 26,
      "billing_address_ref": "ad_iron_bill",
      "shipping_address_ref": "ad_iron_ship"
    },
    {
      "_ref": "q_lake_valves",
      "status": "active",
      "fob_point": "Origin",
      "line_items": [
        {
          "part_ref": "p_valve1100",
          "quantity": 20,
          "sequence": 10,
          "unit_price": 284.0,
          "markup_percent": 44,
          "base_cost_per_unit": 197.22
        },
        {
          "part_ref": "p_flange700",
          "quantity": 40,
          "sequence": 20,
          "unit_price": 52.0
        },
        {
          "part_ref": "p_spacer800",
          "quantity": 100,
          "sequence": 30,
          "unit_price": 8.4
        }
      ],
      "contact_ref": "ct_lake_buy",
      "customer_ref": "c_lakeshore",
      "payment_terms": "Net 30",
      "lead_time_text": "4 weeks ARO",
      "expires_in_days": 48,
      "created_days_ago": 12,
      "billing_address_ref": "ad_lake_bill"
    },
    {
      "_ref": "q_vertex_adapters",
      "status": "active",
      "fob_point": "Origin",
      "line_items": [
        {
          "part_ref": "p_adapter1200",
          "quantity": 50,
          "sequence": 10,
          "unit_price": 74.0,
          "markup_percent": 46,
          "base_cost_per_unit": 50.68
        },
        {
          "part_ref": "p_bought_knob",
          "quantity": 100,
          "sequence": 20,
          "unit_price": 4.6
        }
      ],
      "contact_ref": "ct_vertex_buy",
      "customer_ref": "c_vertex",
      "payment_terms": "Net 30",
      "lead_time_text": "3 weeks ARO",
      "expires_in_days": 52,
      "created_days_ago": 8,
      "billing_address_ref": "ad_vertex_bill"
    },
    {
      "_ref": "q_lake_rollers",
      "status": "active",
      "line_items": [
        {
          "part_ref": "p_roller1300",
          "quantity": 40,
          "sequence": 10,
          "unit_price": 88.0
        },
        {
          "part_ref": "p_bought_handle",
          "quantity": 40,
          "sequence": 20,
          "unit_price": 9.45
        }
      ],
      "contact_ref": "ct_lake_buy",
      "customer_ref": "c_lakeshore",
      "lead_time_text": "Quoted 3 weeks, can pull in to 2 if released this week",
      "expires_in_days": 56,
      "created_days_ago": 4,
      "billing_address_ref": "ad_lake_bill"
    },
    {
      "_ref": "q_summit_clamps",
      "status": "expired",
      "line_items": [
        {
          "part_ref": "p_clamp1400",
          "quantity": 60,
          "sequence": 10,
          "unit_price": 41.0
        }
      ],
      "contact_ref": "ct_summit_buy",
      "customer_ref": "c_summit",
      "payment_terms": "Net 30",
      "lead_time_text": "4 weeks ARO",
      "expires_in_days": -6,
      "created_days_ago": 96,
      "billing_address_ref": "ad_summit_bill"
    },
    {
      "_ref": "q_apex_widget150",
      "status": "expired",
      "line_items": [
        {
          "part_ref": "p_widget150",
          "quantity": 25,
          "sequence": 10,
          "unit_price": 162.0
        }
      ],
      "contact_ref": "ct_apex_buy",
      "customer_ref": "c_apex",
      "payment_terms": "Net 30",
      "lead_time_text": "4 weeks ARO",
      "expires_in_days": -28,
      "created_days_ago": 118,
      "billing_address_ref": "ad_apex_bill",
      "shipping_address_ref": "ad_apex_ship"
    }
  ],
  "vendors": [
    {
      "_ref": "v_steel",
      "city": "Chicago",
      "name": "Midwest Steel Supply",
      "state": "IL",
      "contacts": [
        {
          "name": "Pat Reyes",
          "role": "sales",
          "email": "orders@midweststeel.example.com",
          "phone": "312-555-0142",
          "is_primary": true
        },
        {
          "name": "Dana Whitlock",
          "role": "accounts_payable",
          "email": "ap@midweststeel.example.com",
          "phone": "312-555-0143"
        }
      ],
      "postal_code": "60623",
      "address_line1": "4200 W Cermak Rd"
    },
    {
      "_ref": "v_alloy",
      "city": "Cleveland",
      "name": "Alloy Metals Direct",
      "state": "OH",
      "contacts": [
        {
          "name": "Chris Boland",
          "role": "sales",
          "email": "sales@alloymetals.example.com",
          "phone": "216-555-0188",
          "is_primary": true
        }
      ],
      "postal_code": "44135",
      "address_line1": "1180 Industrial Pkwy"
    },
    {
      "_ref": "v_coating",
      "city": "Cleveland",
      "name": "PerformCoat Finishing",
      "state": "OH",
      "contacts": [
        {
          "name": "Sam Lee",
          "role": "sales",
          "email": "jobs@performcoat.example.com",
          "phone": "216-555-0177",
          "is_primary": true
        },
        {
          "name": "Toni Alvarez",
          "role": "quality",
          "email": "qa@performcoat.example.com",
          "phone": "216-555-0179"
        }
      ],
      "postal_code": "44113",
      "address_line1": "77 Foundry St"
    },
    {
      "_ref": "v_edm",
      "city": "Milwaukee",
      "name": "Precision EDM Partners",
      "state": "WI",
      "contacts": [
        {
          "name": "Jamie Quinn",
          "role": "sales",
          "email": "rfq@precisionedm.example.com",
          "phone": "414-555-0198",
          "is_primary": true
        }
      ],
      "postal_code": "53233",
      "address_line1": "915 Canal St"
    },
    {
      "_ref": "v_fast",
      "city": "Elk Grove Village",
      "name": "Fastener Depot",
      "state": "IL",
      "contacts": [
        {
          "name": "Robin Cho",
          "role": "customer_service",
          "email": "service@fastenerdepot.example.com",
          "phone": "847-555-0121",
          "is_primary": true
        }
      ],
      "postal_code": "60007",
      "address_line1": "2255 Arthur Ave"
    },
    {
      "_ref": "v_heat",
      "city": "Gary",
      "name": "Great Lakes Heat Treat",
      "state": "IN",
      "contacts": [
        {
          "name": "Alex Moreau",
          "role": "sales",
          "email": "scheduling@glheattreat.example.com",
          "phone": "219-555-0164",
          "is_primary": true
        }
      ],
      "postal_code": "46402",
      "address_line1": "500 Buchanan St"
    }
  ],
  "routings": [
    {
      "_ref": "r_sub_blank",
      "name": "SUB-BLANK-001 routing",
      "part_ref": "p_sub_blank",
      "operations": [
        {
          "sequence": 10,
          "instructions": "Cut 1.10 in blanks, deburr ends.",
          "setup_minutes": 8,
          "work_center_ref": "wc_saw",
          "cycle_minutes_per_unit": 0.6
        },
        {
          "sequence": 20,
          "instructions": "Turn OD to 0.980, face both ends.",
          "setup_minutes": 18,
          "work_center_ref": "wc_lathe1",
          "labor_rate_override": 95.0,
          "cycle_minutes_per_unit": 1.8
        }
      ],
      "description": "Saw then turn from 1018 bar"
    },
    {
      "_ref": "r_sub_bracket",
      "name": "SUB-BRACKET-002 routing",
      "part_ref": "p_sub_bracket",
      "operations": [
        {
          "sequence": 10,
          "instructions": "Profile and drill per DWG rev C.",
          "setup_minutes": 15,
          "work_center_ref": "wc_mill1",
          "labor_rate_override": 110.0,
          "cycle_minutes_per_unit": 2.4
        },
        {
          "sequence": 20,
          "setup_minutes": 2,
          "work_center_ref": "wc_deburr",
          "cycle_minutes_per_unit": 0.5
        }
      ],
      "description": "Mill bracket blank from 6061 plate"
    },
    {
      "_ref": "r_sub_shaft",
      "name": "SUB-SHAFT-003 routing",
      "part_ref": "p_sub_shaft",
      "operations": [
        {
          "sequence": 10,
          "setup_minutes": 8,
          "work_center_ref": "wc_saw",
          "cycle_minutes_per_unit": 0.8
        },
        {
          "sequence": 20,
          "instructions": "Rough to 0.020 over finish size.",
          "setup_minutes": 22,
          "work_center_ref": "wc_lathe2",
          "labor_rate_override": 92.0,
          "cycle_minutes_per_unit": 3.2
        },
        {
          "sequence": 30,
          "instructions": "Stress relieve, 1100F, 2 hr.",
          "work_center_ref": "wc_heat",
          "external_unit_price": 3.8
        }
      ],
      "description": "Saw, rough turn, stress relieve"
    },
    {
      "_ref": "r_sub_housing",
      "name": "SUB-HOUSING-004 routing",
      "part_ref": "p_sub_housing",
      "operations": [
        {
          "sequence": 10,
          "instructions": "Op 1: profile, pocket, drill.",
          "setup_minutes": 30,
          "work_center_ref": "wc_mill2",
          "labor_rate_override": 118.0,
          "cycle_minutes_per_unit": 5.5
        },
        {
          "sequence": 20,
          "setup_minutes": 2,
          "work_center_ref": "wc_deburr",
          "cycle_minutes_per_unit": 0.8
        }
      ],
      "description": "Mill housing body from 0.500 plate"
    },
    {
      "_ref": "r_sub_plate",
      "name": "SUB-PLATE-005 routing",
      "part_ref": "p_sub_plate",
      "operations": [
        {
          "sequence": 10,
          "setup_minutes": 12,
          "work_center_ref": "wc_mill1",
          "labor_rate_override": 110.0,
          "cycle_minutes_per_unit": 1.9
        }
      ],
      "description": "Mill plate blank flat and square"
    },
    {
      "_ref": "r_widget100",
      "name": "WIDGET-100 routing",
      "part_ref": "p_widget100",
      "operations": [
        {
          "sequence": 10,
          "instructions": "Finish turn OD and bore. Check 0.9995/0.9990.",
          "setup_minutes": 30,
          "work_center_ref": "wc_lathe1",
          "labor_rate_override": 100.0,
          "cycle_minutes_per_unit": 4.5
        },
        {
          "sequence": 20,
          "instructions": "Mill flats and cross-drill.",
          "setup_minutes": 25,
          "work_center_ref": "wc_mill1",
          "labor_rate_override": 115.0,
          "cycle_minutes_per_unit": 3.75
        },
        {
          "sequence": 30,
          "instructions": "Type II clear anodize, mask bore.",
          "work_center_ref": "wc_coating",
          "external_unit_price": 4.5
        },
        {
          "sequence": 40,
          "instructions": "Install o-ring and 4x SHCS.",
          "setup_minutes": 10,
          "work_center_ref": "wc_assy",
          "cycle_minutes_per_unit": 2.2
        },
        {
          "sequence": 50,
          "instructions": "CMM first article, then 1 in 10.",
          "setup_minutes": 5,
          "work_center_ref": "wc_qc",
          "cycle_minutes_per_unit": 0.5
        }
      ],
      "description": "Turn, mill, anodize, assemble, inspect"
    },
    {
      "_ref": "r_widget150",
      "name": "WIDGET-150 routing",
      "part_ref": "p_widget150",
      "operations": [
        {
          "sequence": 10,
          "setup_minutes": 32,
          "work_center_ref": "wc_lathe1",
          "labor_rate_override": 100.0,
          "cycle_minutes_per_unit": 5.2
        },
        {
          "sequence": 20,
          "setup_minutes": 28,
          "work_center_ref": "wc_mill2",
          "labor_rate_override": 118.0,
          "cycle_minutes_per_unit": 4.1
        },
        {
          "sequence": 30,
          "work_center_ref": "wc_coating",
          "external_unit_price": 5.1
        },
        {
          "sequence": 40,
          "setup_minutes": 10,
          "work_center_ref": "wc_assy",
          "cycle_minutes_per_unit": 2.6
        },
        {
          "sequence": 50,
          "setup_minutes": 5,
          "work_center_ref": "wc_qc",
          "cycle_minutes_per_unit": 0.6
        }
      ],
      "description": "Extended body variant of the WIDGET-100 flow"
    },
    {
      "_ref": "r_bracket300",
      "name": "BRACKET-300 routing",
      "part_ref": "p_bracket300",
      "operations": [
        {
          "sequence": 10,
          "instructions": "Second op: tap 2x 1/4-20 for inserts.",
          "setup_minutes": 20,
          "work_center_ref": "wc_mill1",
          "labor_rate_override": 120.0,
          "cycle_minutes_per_unit": 5.0
        },
        {
          "sequence": 20,
          "instructions": "Black anodize per MIL-A-8625 Type II Class 2.",
          "work_center_ref": "wc_coating",
          "external_unit_price": 3.25
        },
        {
          "sequence": 30,
          "instructions": "Install 2x helical inserts.",
          "setup_minutes": 6,
          "work_center_ref": "wc_assy",
          "cycle_minutes_per_unit": 1.1
        },
        {
          "sequence": 40,
          "setup_minutes": 5,
          "work_center_ref": "wc_qc",
          "labor_rate_override": 80.0,
          "cycle_minutes_per_unit": 0.4
        }
      ],
      "description": "Mill, anodize, insert, inspect"
    },
    {
      "_ref": "r_bracket350",
      "name": "BRACKET-350 routing",
      "part_ref": "p_bracket350",
      "operations": [
        {
          "sequence": 10,
          "setup_minutes": 22,
          "work_center_ref": "wc_mill1",
          "labor_rate_override": 120.0,
          "cycle_minutes_per_unit": 5.4
        },
        {
          "sequence": 20,
          "instructions": "Manual: relieve back face.",
          "setup_minutes": 15,
          "work_center_ref": "wc_mill3",
          "cycle_minutes_per_unit": 3.0
        },
        {
          "sequence": 30,
          "work_center_ref": "wc_coating",
          "external_unit_price": 3.6
        },
        {
          "sequence": 40,
          "setup_minutes": 5,
          "work_center_ref": "wc_qc",
          "cycle_minutes_per_unit": 0.5
        }
      ],
      "description": "Heavy-duty bracket, two milling ops"
    },
    {
      "_ref": "r_pin200",
      "name": "PIN-200 routing",
      "part_ref": "p_pin200",
      "operations": [
        {
          "sequence": 10,
          "setup_minutes": 22,
          "work_center_ref": "wc_lathe1",
          "labor_rate_override": 105.0,
          "cycle_minutes_per_unit": 2.8
        },
        {
          "sequence": 20,
          "instructions": "Wire keyway 0.125 wide x 0.060 deep.",
          "work_center_ref": "wc_edm",
          "external_unit_price": 8.75
        },
        {
          "sequence": 30,
          "instructions": "Through-harden to 58-62 HRC.",
          "work_center_ref": "wc_heat",
          "external_unit_price": 2.9
        },
        {
          "sequence": 40,
          "setup_minutes": 5,
          "work_center_ref": "wc_qc",
          "labor_rate_override": 78.0,
          "cycle_minutes_per_unit": 0.3
        }
      ],
      "description": "Turn, outside EDM keyway, harden, inspect"
    },
    {
      "_ref": "r_shaft400",
      "name": "SHAFT-400 routing",
      "part_ref": "p_shaft400",
      "operations": [
        {
          "sequence": 10,
          "setup_minutes": 25,
          "work_center_ref": "wc_lathe2",
          "labor_rate_override": 92.0,
          "cycle_minutes_per_unit": 4.0
        },
        {
          "sequence": 20,
          "work_center_ref": "wc_heat",
          "external_unit_price": 4.2
        },
        {
          "sequence": 30,
          "instructions": "Finish journals to print after HT.",
          "setup_minutes": 15,
          "work_center_ref": "wc_lathe2",
          "cycle_minutes_per_unit": 2.5
        },
        {
          "sequence": 40,
          "instructions": "Press 2x oil bushings.",
          "setup_minutes": 8,
          "work_center_ref": "wc_assy",
          "cycle_minutes_per_unit": 1.5
        },
        {
          "sequence": 50,
          "setup_minutes": 6,
          "work_center_ref": "wc_qc",
          "cycle_minutes_per_unit": 0.7
        }
      ],
      "description": "Finish turn after heat treat, press bushings"
    },
    {
      "_ref": "r_housing500",
      "name": "HOUSING-500 routing",
      "part_ref": "p_housing500",
      "operations": [
        {
          "sequence": 10,
          "instructions": "Op 2: bore and o-ring groove.",
          "setup_minutes": 35,
          "work_center_ref": "wc_mill2",
          "labor_rate_override": 118.0,
          "cycle_minutes_per_unit": 6.8
        },
        {
          "sequence": 20,
          "setup_minutes": 2,
          "work_center_ref": "wc_deburr",
          "cycle_minutes_per_unit": 1.0
        },
        {
          "sequence": 30,
          "work_center_ref": "wc_coating",
          "external_unit_price": 6.2
        },
        {
          "sequence": 40,
          "instructions": "CMM every part, groove depth critical.",
          "setup_minutes": 8,
          "work_center_ref": "wc_qc",
          "cycle_minutes_per_unit": 1.2
        }
      ],
      "description": "Second op, anodize, o-ring fit"
    },
    {
      "_ref": "r_manifold600",
      "name": "MANIFOLD-600 routing",
      "part_ref": "p_manifold600",
      "operations": [
        {
          "sequence": 10,
          "instructions": "Cross-drilled ports, watch burr at intersections.",
          "setup_minutes": 55,
          "work_center_ref": "wc_mill2",
          "labor_rate_override": 118.0,
          "cycle_minutes_per_unit": 22.0
        },
        {
          "sequence": 20,
          "instructions": "Scope every port intersection.",
          "setup_minutes": 5,
          "work_center_ref": "wc_deburr",
          "cycle_minutes_per_unit": 6.0
        },
        {
          "sequence": 30,
          "setup_minutes": 10,
          "work_center_ref": "wc_qc",
          "cycle_minutes_per_unit": 3.0
        }
      ],
      "description": "Four-side manifold, deburr critical"
    },
    {
      "_ref": "r_flange700",
      "name": "FLANGE-700 routing",
      "part_ref": "p_flange700",
      "operations": [
        {
          "sequence": 10,
          "setup_minutes": 18,
          "work_center_ref": "wc_mill1",
          "labor_rate_override": 110.0,
          "cycle_minutes_per_unit": 4.2
        },
        {
          "sequence": 20,
          "instructions": "Passivate per ASTM A967.",
          "work_center_ref": "wc_coating",
          "external_unit_price": 2.4
        },
        {
          "sequence": 30,
          "setup_minutes": 5,
          "work_center_ref": "wc_qc",
          "cycle_minutes_per_unit": 0.5
        }
      ],
      "description": "Stainless flange, mill and passivate"
    },
    {
      "_ref": "r_spacer800",
      "name": "SPACER-800 routing",
      "part_ref": "p_spacer800",
      "operations": [
        {
          "sequence": 10,
          "instructions": "Run dry, no coolant on Delrin.",
          "setup_minutes": 12,
          "work_center_ref": "wc_lathe1",
          "labor_rate_override": 95.0,
          "cycle_minutes_per_unit": 0.9
        }
      ],
      "description": "Single-op turned Delrin spacer"
    },
    {
      "_ref": "r_cover900",
      "name": "COVER-900 routing",
      "part_ref": "p_cover900",
      "operations": [
        {
          "sequence": 10,
          "setup_minutes": 14,
          "work_center_ref": "wc_mill1",
          "labor_rate_override": 110.0,
          "cycle_minutes_per_unit": 2.8
        },
        {
          "sequence": 20,
          "work_center_ref": "wc_coating",
          "external_unit_price": 2.8
        },
        {
          "sequence": 30,
          "setup_minutes": 4,
          "work_center_ref": "wc_qc",
          "cycle_minutes_per_unit": 0.3
        }
      ],
      "description": "Mill and anodize clear"
    },
    {
      "_ref": "r_valve1100",
      "name": "VALVE-BODY-1100 routing",
      "part_ref": "p_valve1100",
      "operations": [
        {
          "sequence": 10,
          "setup_minutes": 28,
          "work_center_ref": "wc_lathe1",
          "labor_rate_override": 100.0,
          "cycle_minutes_per_unit": 6.5
        },
        {
          "sequence": 20,
          "setup_minutes": 24,
          "work_center_ref": "wc_mill2",
          "labor_rate_override": 118.0,
          "cycle_minutes_per_unit": 4.8
        },
        {
          "sequence": 30,
          "setup_minutes": 3,
          "work_center_ref": "wc_deburr",
          "cycle_minutes_per_unit": 1.4
        },
        {
          "sequence": 40,
          "setup_minutes": 6,
          "work_center_ref": "wc_qc",
          "cycle_minutes_per_unit": 0.9
        }
      ],
      "description": "Turn-mill stainless valve body"
    },
    {
      "_ref": "r_adapter1200",
      "name": "ADAPTER-1200 routing",
      "part_ref": "p_adapter1200",
      "operations": [
        {
          "sequence": 10,
          "setup_minutes": 6,
          "work_center_ref": "wc_saw",
          "cycle_minutes_per_unit": 0.5
        },
        {
          "sequence": 20,
          "instructions": "Thread both ends, 1-1/16-12 UN.",
          "setup_minutes": 20,
          "work_center_ref": "wc_lathe2",
          "labor_rate_override": 92.0,
          "cycle_minutes_per_unit": 3.4
        },
        {
          "sequence": 30,
          "setup_minutes": 4,
          "work_center_ref": "wc_qc",
          "cycle_minutes_per_unit": 0.4
        }
      ],
      "description": "Turn tube adapter both ends"
    },
    {
      "_ref": "r_gear1000",
      "name": "GEAR-BLANK-1000 routing",
      "part_ref": "p_gear1000",
      "operations": [
        {
          "sequence": 10,
          "setup_minutes": 8,
          "work_center_ref": "wc_saw",
          "cycle_minutes_per_unit": 0.9
        },
        {
          "sequence": 20,
          "instructions": "Leave 0.030 on the OD for the hobber.",
          "setup_minutes": 24,
          "work_center_ref": "wc_lathe2",
          "labor_rate_override": 92.0,
          "cycle_minutes_per_unit": 3.8
        },
        {
          "sequence": 30,
          "work_center_ref": "wc_heat",
          "external_unit_price": 3.4
        },
        {
          "sequence": 40,
          "setup_minutes": 5,
          "work_center_ref": "wc_qc",
          "cycle_minutes_per_unit": 0.4
        }
      ],
      "description": "Saw, turn, stress relieve"
    },
    {
      "_ref": "r_plateassy",
      "name": "PLATE-ASSY-1500 routing",
      "part_ref": "p_plateassy",
      "operations": [
        {
          "sequence": 10,
          "instructions": "Tap 4x 1/4-20, ream 2x dowel holes.",
          "setup_minutes": 16,
          "work_center_ref": "wc_mill1",
          "labor_rate_override": 110.0,
          "cycle_minutes_per_unit": 2.2
        },
        {
          "sequence": 20,
          "instructions": "Install 4x inserts, press 2x dowels.",
          "setup_minutes": 8,
          "work_center_ref": "wc_assy",
          "cycle_minutes_per_unit": 3.0
        },
        {
          "sequence": 30,
          "setup_minutes": 5,
          "work_center_ref": "wc_qc",
          "cycle_minutes_per_unit": 0.6
        }
      ],
      "description": "Install inserts and dowels into the plate blank"
    },
    {
      "_ref": "r_clamp1400",
      "name": "CLAMP-1400 routing",
      "part_ref": "p_clamp1400",
      "operations": [
        {
          "sequence": 10,
          "setup_minutes": 6,
          "work_center_ref": "wc_saw",
          "cycle_minutes_per_unit": 0.4
        },
        {
          "sequence": 20,
          "setup_minutes": 18,
          "work_center_ref": "wc_lathe1",
          "labor_rate_override": 95.0,
          "cycle_minutes_per_unit": 2.1
        },
        {
          "sequence": 30,
          "instructions": "Cross-drill 0.125 for the spring pins.",
          "setup_minutes": 12,
          "work_center_ref": "wc_mill3",
          "cycle_minutes_per_unit": 1.8
        },
        {
          "sequence": 40,
          "setup_minutes": 2,
          "work_center_ref": "wc_deburr",
          "cycle_minutes_per_unit": 0.6
        }
      ],
      "description": "Saw, turn, cross-drill, pin"
    }
  ],
  "customers": [
    {
      "_ref": "c_apex",
      "name": "Apex Aerospace",
      "contacts": [
        {
          "_ref": "ct_apex_buy",
          "name": "Morgan Lee",
          "role": "buyer",
          "email": "purchasing@apexaero.example.com",
          "phone": "316-555-0110",
          "is_primary": true
        },
        {
          "_ref": "ct_apex_ap",
          "name": "Jordan Fields",
          "role": "accounts_payable",
          "email": "ap@apexaero.example.com",
          "phone": "316-555-0111",
          "is_billing_default": true
        },
        {
          "name": "Priya Raman",
          "role": "quality",
          "email": "quality@apexaero.example.com",
          "phone": "316-555-0112"
        }
      ],
      "addresses": [
        {
          "_ref": "ad_apex_bill",
          "city": "Wichita",
          "state": "KS",
          "postal_code": "67209",
          "attention_to": "Accounts Payable",
          "address_line1": "3300 Airport Rd",
          "address_line2": "Building 4",
          "default_billing": true
        },
        {
          "_ref": "ad_apex_ship",
          "city": "Wichita",
          "state": "KS",
          "postal_code": "67209",
          "attention_to": "Receiving",
          "address_line1": "3300 Airport Rd",
          "address_line2": "Dock 7",
          "default_shipping": true
        }
      ],
      "credit_status": "open",
      "default_fob_point": "Origin",
      "default_payment_terms": "Net 30"
    },
    {
      "_ref": "c_helix",
      "name": "Helix Robotics",
      "contacts": [
        {
          "_ref": "ct_helix_buy",
          "name": "Riley Park",
          "role": "buyer",
          "email": "po@helixrobotics.example.com",
          "phone": "412-555-0130",
          "is_primary": true
        },
        {
          "name": "Devin Oyelaran",
          "role": "engineering",
          "email": "eng@helixrobotics.example.com",
          "phone": "412-555-0131"
        }
      ],
      "addresses": [
        {
          "_ref": "ad_helix_bill",
          "city": "Pittsburgh",
          "state": "PA",
          "postal_code": "15219",
          "address_line1": "50 Innovation Dr",
          "default_billing": true
        },
        {
          "_ref": "ad_helix_ship",
          "city": "Pittsburgh",
          "state": "PA",
          "postal_code": "15219",
          "address_line1": "50 Innovation Dr",
          "address_line2": "Receiving, Rear Entrance",
          "default_shipping": true
        }
      ],
      "credit_status": "open",
      "default_fob_point": "Destination",
      "default_payment_terms": "Net 45"
    },
    {
      "_ref": "c_north",
      "name": "Northstar Medical",
      "contacts": [
        {
          "_ref": "ct_north_buy",
          "name": "Casey Singh",
          "role": "buyer",
          "email": "orders@northstarmed.example.com",
          "phone": "612-555-0155",
          "is_primary": true
        },
        {
          "name": "Alexis Trudeau",
          "role": "quality",
          "email": "qa@northstarmed.example.com",
          "phone": "612-555-0156"
        }
      ],
      "addresses": [
        {
          "_ref": "ad_north_bill",
          "city": "Minneapolis",
          "state": "MN",
          "postal_code": "55454",
          "address_line1": "1400 Riverside Ave",
          "default_billing": true,
          "default_shipping": true
        }
      ],
      "credit_status": "open",
      "default_fob_point": "Origin",
      "default_payment_terms": "Net 30"
    },
    {
      "_ref": "c_cascade",
      "name": "Cascade Hydraulics",
      "contacts": [
        {
          "_ref": "ct_cascade_buy",
          "name": "Sam Okafor",
          "role": "buyer",
          "email": "buying@cascadehyd.example.com",
          "phone": "503-555-0170",
          "is_primary": true
        }
      ],
      "addresses": [
        {
          "_ref": "ad_cascade_bill",
          "city": "Portland",
          "state": "OR",
          "postal_code": "97266",
          "address_line1": "8800 SE Foster Rd",
          "default_billing": true,
          "default_shipping": true
        }
      ],
      "credit_status": "open",
      "default_fob_point": "Origin",
      "default_payment_terms": "Net 30"
    },
    {
      "_ref": "c_ironclad",
      "name": "Ironclad Defense Systems",
      "contacts": [
        {
          "_ref": "ct_iron_buy",
          "name": "Terry Vaughn",
          "role": "buyer",
          "email": "procurement@ironcladds.example.com",
          "phone": "256-555-0182",
          "is_primary": true
        },
        {
          "name": "Noor Haddad",
          "role": "quality",
          "email": "qms@ironcladds.example.com",
          "phone": "256-555-0183"
        }
      ],
      "addresses": [
        {
          "_ref": "ad_iron_bill",
          "city": "Huntsville",
          "state": "AL",
          "postal_code": "35808",
          "attention_to": "AP Dept",
          "address_line1": "620 Redstone Blvd",
          "default_billing": true
        },
        {
          "_ref": "ad_iron_ship",
          "city": "Huntsville",
          "state": "AL",
          "postal_code": "35808",
          "address_line1": "620 Redstone Blvd",
          "address_line2": "Gate 3 Receiving",
          "default_shipping": true
        }
      ],
      "credit_status": "open",
      "default_fob_point": "Destination",
      "default_payment_terms": "Net 60"
    },
    {
      "_ref": "c_lakeshore",
      "name": "Lakeshore Packaging Equipment",
      "contacts": [
        {
          "_ref": "ct_lake_buy",
          "name": "Bev Ostrowski",
          "role": "buyer",
          "email": "purchasing@lakeshorepack.example.com",
          "phone": "414-555-0144",
          "is_primary": true
        }
      ],
      "addresses": [
        {
          "_ref": "ad_lake_bill",
          "city": "Milwaukee",
          "state": "WI",
          "postal_code": "53207",
          "address_line1": "2100 S 1st St",
          "default_billing": true,
          "default_shipping": true
        }
      ],
      "credit_status": "open",
      "default_fob_point": "Origin",
      "default_payment_terms": "Net 30"
    },
    {
      "_ref": "c_vertex",
      "name": "Vertex Energy Controls",
      "contacts": [
        {
          "_ref": "ct_vertex_buy",
          "name": "Ade Balogun",
          "role": "buyer",
          "email": "supply@vertexenergy.example.com",
          "phone": "713-555-0191",
          "is_primary": true
        }
      ],
      "addresses": [
        {
          "_ref": "ad_vertex_bill",
          "city": "Houston",
          "state": "TX",
          "postal_code": "77024",
          "address_line1": "9010 Katy Fwy",
          "default_billing": true,
          "default_shipping": true
        }
      ],
      "credit_status": "open",
      "default_fob_point": "Origin",
      "default_payment_terms": "Net 30"
    },
    {
      "_ref": "c_summit",
      "name": "Summit Ag Equipment",
      "contacts": [
        {
          "_ref": "ct_summit_buy",
          "name": "Dale Hoffmann",
          "role": "buyer",
          "email": "parts@summitag.example.com",
          "phone": "515-555-0128",
          "is_primary": true
        }
      ],
      "addresses": [
        {
          "_ref": "ad_summit_bill",
          "city": "Des Moines",
          "state": "IA",
          "postal_code": "50317",
          "address_line1": "455 SE 30th St",
          "default_billing": true,
          "default_shipping": true
        }
      ],
      "credit_status": "hold",
      "credit_hold_note": "Two invoices past 60 days. Release requires a check before the next release to production.",
      "default_fob_point": "Origin",
      "default_payment_terms": "Net 30"
    }
  ],
  "locations": [
    {
      "_ref": "loc_raw",
      "kind": "rack",
      "name": "Raw Material Rack",
      "sort_order": 10
    },
    {
      "_ref": "loc_raw_a",
      "kind": "bay",
      "name": "Bay A",
      "parent_ref": "loc_raw",
      "sort_order": 10
    },
    {
      "_ref": "loc_raw_b",
      "kind": "bay",
      "name": "Bay B",
      "parent_ref": "loc_raw",
      "sort_order": 20
    },
    {
      "_ref": "loc_raw_c",
      "kind": "bay",
      "name": "Bay C",
      "parent_ref": "loc_raw",
      "sort_order": 30
    },
    {
      "_ref": "loc_shelf1",
      "kind": "cabinet",
      "name": "Shelving Unit 1",
      "sort_order": 20
    },
    {
      "_ref": "loc_shelf1_a",
      "kind": "shelf",
      "name": "Shelf 1-A",
      "parent_ref": "loc_shelf1",
      "sort_order": 10
    },
    {
      "_ref": "loc_shelf1_b",
      "kind": "shelf",
      "name": "Shelf 1-B",
      "parent_ref": "loc_shelf1",
      "sort_order": 20
    },
    {
      "_ref": "loc_shelf1_c",
      "kind": "shelf",
      "name": "Shelf 1-C",
      "parent_ref": "loc_shelf1",
      "sort_order": 30
    },
    {
      "_ref": "loc_shelf2",
      "kind": "cabinet",
      "name": "Shelving Unit 2",
      "sort_order": 30
    },
    {
      "_ref": "loc_shelf2_a",
      "kind": "shelf",
      "name": "Shelf 2-A",
      "parent_ref": "loc_shelf2",
      "sort_order": 10
    },
    {
      "_ref": "loc_shelf2_b",
      "kind": "shelf",
      "name": "Shelf 2-B",
      "parent_ref": "loc_shelf2",
      "sort_order": 20
    },
    {
      "_ref": "loc_hw",
      "kind": "cabinet",
      "name": "Hardware Cabinet",
      "sort_order": 40
    },
    {
      "_ref": "loc_hw_1",
      "kind": "bin",
      "name": "Bin H1",
      "parent_ref": "loc_hw",
      "sort_order": 10
    },
    {
      "_ref": "loc_hw_2",
      "kind": "bin",
      "name": "Bin H2",
      "parent_ref": "loc_hw",
      "sort_order": 20
    },
    {
      "_ref": "loc_hw_3",
      "kind": "bin",
      "name": "Bin H3",
      "parent_ref": "loc_hw",
      "sort_order": 30
    },
    {
      "_ref": "loc_fg",
      "kind": "area",
      "name": "Finished Goods",
      "sort_order": 50
    },
    {
      "_ref": "loc_fg_1",
      "kind": "pallet",
      "name": "FG Pallet 1",
      "parent_ref": "loc_fg",
      "sort_order": 10
    },
    {
      "_ref": "loc_fg_2",
      "kind": "pallet",
      "name": "FG Pallet 2",
      "parent_ref": "loc_fg",
      "sort_order": 20
    },
    {
      "_ref": "loc_crib",
      "kind": "cabinet",
      "name": "Tool Crib",
      "sort_order": 60
    }
  ],
  "parts_bom": [
    {
      "unit": "in",
      "notes": "Includes cutoff allowance",
      "quantity": 1.1,
      "sequence": 10,
      "child_ref": "p_bar1018_1",
      "parent_ref": "p_sub_blank"
    },
    {
      "unit": "sqin",
      "quantity": 14,
      "sequence": 10,
      "child_ref": "p_plate6061_25",
      "parent_ref": "p_sub_bracket"
    },
    {
      "unit": "in",
      "quantity": 4.25,
      "sequence": 10,
      "child_ref": "p_bar4140",
      "parent_ref": "p_sub_shaft"
    },
    {
      "unit": "sqin",
      "quantity": 22,
      "sequence": 10,
      "child_ref": "p_plate6061_50",
      "parent_ref": "p_sub_housing"
    },
    {
      "unit": "sqin",
      "quantity": 18,
      "sequence": 10,
      "child_ref": "p_plate7075",
      "parent_ref": "p_sub_plate"
    },
    {
      "unit": "each",
      "quantity": 1,
      "sequence": 10,
      "child_ref": "p_sub_blank",
      "parent_ref": "p_widget100",
      "consume_whole_units": true
    },
    {
      "unit": "each",
      "quantity": 4,
      "sequence": 20,
      "child_ref": "p_shcs14",
      "parent_ref": "p_widget100",
      "consume_whole_units": true
    },
    {
      "unit": "each",
      "quantity": 1,
      "sequence": 30,
      "child_ref": "p_oring",
      "parent_ref": "p_widget100",
      "consume_whole_units": true
    },
    {
      "unit": "each",
      "quantity": 1,
      "sequence": 10,
      "child_ref": "p_sub_blank",
      "parent_ref": "p_widget150",
      "consume_whole_units": true
    },
    {
      "unit": "in",
      "quantity": 0.85,
      "sequence": 20,
      "child_ref": "p_bar1018_1",
      "parent_ref": "p_widget150"
    },
    {
      "unit": "each",
      "quantity": 6,
      "sequence": 30,
      "child_ref": "p_shcs14",
      "parent_ref": "p_widget150",
      "consume_whole_units": true
    },
    {
      "unit": "each",
      "quantity": 1,
      "sequence": 10,
      "child_ref": "p_sub_bracket",
      "parent_ref": "p_bracket300",
      "consume_whole_units": true
    },
    {
      "unit": "each",
      "quantity": 2,
      "sequence": 20,
      "child_ref": "p_insert",
      "parent_ref": "p_bracket300",
      "consume_whole_units": true
    },
    {
      "unit": "each",
      "quantity": 1,
      "sequence": 10,
      "child_ref": "p_sub_bracket",
      "parent_ref": "p_bracket350",
      "consume_whole_units": true
    },
    {
      "unit": "sqin",
      "quantity": 9,
      "sequence": 20,
      "child_ref": "p_plate6061_50",
      "parent_ref": "p_bracket350"
    },
    {
      "unit": "each",
      "quantity": 4,
      "sequence": 30,
      "child_ref": "p_shcs10",
      "parent_ref": "p_bracket350",
      "consume_whole_units": true
    },
    {
      "unit": "in",
      "quantity": 1.35,
      "sequence": 10,
      "child_ref": "p_bar1018_075",
      "parent_ref": "p_pin200"
    },
    {
      "unit": "each",
      "quantity": 1,
      "sequence": 10,
      "child_ref": "p_sub_shaft",
      "parent_ref": "p_shaft400",
      "consume_whole_units": true
    },
    {
      "unit": "each",
      "quantity": 2,
      "sequence": 20,
      "child_ref": "p_bushing",
      "parent_ref": "p_shaft400",
      "consume_whole_units": true
    },
    {
      "unit": "each",
      "quantity": 1,
      "sequence": 10,
      "child_ref": "p_sub_housing",
      "parent_ref": "p_housing500",
      "consume_whole_units": true
    },
    {
      "unit": "each",
      "quantity": 2,
      "sequence": 20,
      "child_ref": "p_oring",
      "parent_ref": "p_housing500",
      "consume_whole_units": true
    },
    {
      "unit": "sqin",
      "quantity": 36,
      "sequence": 10,
      "child_ref": "p_plate7075",
      "parent_ref": "p_manifold600"
    },
    {
      "unit": "each",
      "quantity": 4,
      "sequence": 20,
      "child_ref": "p_oring",
      "parent_ref": "p_manifold600",
      "consume_whole_units": true
    },
    {
      "unit": "sqin",
      "quantity": 20,
      "sequence": 10,
      "child_ref": "p_sheet304",
      "parent_ref": "p_flange700"
    },
    {
      "unit": "in",
      "quantity": 0.45,
      "sequence": 10,
      "child_ref": "p_delrin",
      "parent_ref": "p_spacer800"
    },
    {
      "unit": "sqin",
      "quantity": 24,
      "sequence": 10,
      "child_ref": "p_plate6061_25",
      "parent_ref": "p_cover900"
    },
    {
      "unit": "in",
      "quantity": 1.6,
      "sequence": 10,
      "child_ref": "p_bar4140",
      "parent_ref": "p_gear1000"
    },
    {
      "unit": "in",
      "quantity": 2.8,
      "sequence": 10,
      "child_ref": "p_bar303",
      "parent_ref": "p_valve1100"
    },
    {
      "unit": "each",
      "quantity": 2,
      "sequence": 20,
      "child_ref": "p_oring",
      "parent_ref": "p_valve1100",
      "consume_whole_units": true
    },
    {
      "unit": "in",
      "quantity": 2.2,
      "sequence": 10,
      "child_ref": "p_tube6061",
      "parent_ref": "p_adapter1200"
    },
    {
      "unit": "in",
      "quantity": 6.5,
      "sequence": 10,
      "child_ref": "p_bar1018_1",
      "parent_ref": "p_roller1300"
    },
    {
      "unit": "each",
      "quantity": 2,
      "sequence": 20,
      "child_ref": "p_bushing",
      "parent_ref": "p_roller1300",
      "consume_whole_units": true
    },
    {
      "unit": "in",
      "quantity": 2.1,
      "sequence": 10,
      "child_ref": "p_bar1018_075",
      "parent_ref": "p_clamp1400"
    },
    {
      "unit": "each",
      "quantity": 2,
      "sequence": 20,
      "child_ref": "p_springpin",
      "parent_ref": "p_clamp1400",
      "consume_whole_units": true
    },
    {
      "unit": "each",
      "quantity": 1,
      "sequence": 10,
      "child_ref": "p_sub_plate",
      "parent_ref": "p_plateassy",
      "consume_whole_units": true
    },
    {
      "unit": "each",
      "quantity": 4,
      "sequence": 20,
      "child_ref": "p_insert",
      "parent_ref": "p_plateassy",
      "consume_whole_units": true
    },
    {
      "unit": "each",
      "quantity": 2,
      "sequence": 30,
      "child_ref": "p_dowel",
      "parent_ref": "p_plateassy",
      "consume_whole_units": true
    },
    {
      "unit": "sqin",
      "quantity": 6,
      "sequence": 10,
      "child_ref": "p_sheet304",
      "parent_ref": "p_shim1600"
    }
  ],
  "shipments": [
    {
      "_ref": "s_apex_repeat_1",
      "carrier": "UPS",
      "job_ref": "j_apex_repeat",
      "line_items": [
        {
          "quantity": 40,
          "job_part_ref": "jp_apex_repeat_widget"
        }
      ],
      "customer_ref": "c_apex",
      "freight_terms": "prepaid",
      "ship_days_ago": 42,
      "shipping_method": "shipment",
      "shipping_address_ref": "ad_apex_ship"
    },
    {
      "_ref": "s_helix_repeat_1",
      "carrier": "Customer carrier",
      "job_ref": "j_helix_repeat",
      "line_items": [
        {
          "quantity": 60,
          "job_part_ref": "jp_helix_repeat_bracket"
        }
      ],
      "customer_ref": "c_helix",
      "freight_terms": "collect",
      "ship_days_ago": 40,
      "shipping_method": "shipment",
      "shipping_address_ref": "ad_helix_ship"
    },
    {
      "_ref": "s_north_repeat_1",
      "carrier": "FedEx",
      "job_ref": "j_north_repeat",
      "line_items": [
        {
          "quantity": 40,
          "job_part_ref": "jp_north_repeat_flange"
        }
      ],
      "customer_ref": "c_north",
      "freight_terms": "prepaid",
      "ship_days_ago": 38,
      "shipping_method": "shipment",
      "shipping_address_ref": "ad_north_bill"
    },
    {
      "_ref": "s_cascade_repeat_1",
      "carrier": "UPS",
      "job_ref": "j_cascade_repeat",
      "line_items": [
        {
          "quantity": 200,
          "job_part_ref": "jp_cascade_repeat_spacer"
        }
      ],
      "customer_ref": "c_cascade",
      "freight_terms": "prepaid",
      "ship_days_ago": 36,
      "shipping_method": "shipment",
      "shipping_address_ref": "ad_cascade_bill"
    },
    {
      "_ref": "s_cascade_repeat_2",
      "carrier": "UPS",
      "job_ref": "j_cascade_repeat",
      "line_items": [
        {
          "quantity": 18,
          "job_part_ref": "jp_cascade_repeat_cover"
        }
      ],
      "customer_ref": "c_cascade",
      "freight_terms": "prepaid",
      "ship_days_ago": 30,
      "shipping_method": "shipment",
      "shipping_address_ref": "ad_cascade_bill"
    },
    {
      "_ref": "s_apex_partial",
      "carrier": "UPS",
      "job_ref": "j_apex_widgets",
      "line_items": [
        {
          "quantity": 10,
          "job_part_ref": "jp_apex_widget"
        }
      ],
      "customer_ref": "c_apex",
      "freight_terms": "prepaid",
      "ship_days_ago": 1,
      "shipping_method": "shipment",
      "shipping_address_ref": "ad_apex_ship"
    }
  ],
  "custom_units": [
    "stick",
    "sheet",
    "gal"
  ],
  "work_centers": [
    {
      "_ref": "wc_saw",
      "kind": "internal",
      "make": "Marvel",
      "name": "Marvel Saw",
      "model": "Series 8 Mark II",
      "labor_rate": 62.0,
      "year_built": 2014,
      "description": "Horizontal bandsaw, raw stock cutoff",
      "serial_number": "MV-88214",
      "purchased_years_ago": 8
    },
    {
      "_ref": "wc_lathe1",
      "kind": "internal",
      "make": "Mazak",
      "name": "Mazak QT-200",
      "model": "Quick Turn 200MY",
      "labor_rate": 95.0,
      "year_built": 2018,
      "description": "CNC turning cell, bar feed",
      "serial_number": "MZ-200-4471",
      "purchased_years_ago": 5
    },
    {
      "_ref": "wc_lathe2",
      "kind": "internal",
      "make": "Haas",
      "name": "Haas ST-30",
      "model": "ST-30Y",
      "labor_rate": 92.0,
      "year_built": 2021,
      "description": "CNC turning, larger envelope",
      "serial_number": "HS-30Y-1192",
      "purchased_years_ago": 3
    },
    {
      "_ref": "wc_mill1",
      "kind": "internal",
      "make": "HURCO",
      "name": "HURCO VM10",
      "model": "VM10i",
      "labor_rate": 110.0,
      "year_built": 2016,
      "description": "3-axis VMC, mid-volume parts",
      "serial_number": "HU-VM10-3320",
      "purchased_years_ago": 7
    },
    {
      "_ref": "wc_mill2",
      "kind": "internal",
      "make": "Haas",
      "name": "Haas VF-4SS",
      "model": "VF-4SS",
      "labor_rate": 118.0,
      "year_built": 2022,
      "description": "4-axis VMC, high-speed spindle",
      "serial_number": "HS-VF4-8804",
      "purchased_years_ago": 2
    },
    {
      "_ref": "wc_mill3",
      "kind": "internal",
      "make": "Bridgeport",
      "name": "Bridgeport Manual",
      "model": "Series I",
      "labor_rate": 78.0,
      "year_built": 1998,
      "description": "Manual knee mill, one-offs and fixtures",
      "serial_number": "BP-S1-0442",
      "purchased_years_ago": 19
    },
    {
      "_ref": "wc_deburr",
      "kind": "internal",
      "name": "Deburr Bench",
      "labor_rate": 55.0,
      "description": "Hand deburr and edge break"
    },
    {
      "_ref": "wc_assy",
      "kind": "internal",
      "name": "Assembly Bench",
      "labor_rate": 68.0,
      "description": "Sub-assembly and hardware install"
    },
    {
      "_ref": "wc_qc",
      "kind": "internal",
      "make": "Brown & Sharpe",
      "name": "QC Bench",
      "model": "Global S 7.10.7",
      "labor_rate": 75.0,
      "year_built": 2019,
      "description": "CMM plus manual gauging",
      "serial_number": "BS-GS-2207",
      "purchased_years_ago": 4
    },
    {
      "_ref": "wc_coating",
      "kind": "external",
      "name": "PerformCoat Anodize",
      "vendor_ref": "v_coating",
      "description": "Outside anodize and black oxide"
    },
    {
      "_ref": "wc_edm",
      "kind": "external",
      "name": "Precision Wire EDM",
      "vendor_ref": "v_edm",
      "description": "Outside wire EDM, tight-tolerance features"
    },
    {
      "_ref": "wc_heat",
      "kind": "external",
      "name": "Great Lakes Heat Treat",
      "vendor_ref": "v_heat",
      "description": "Outside through-hardening and stress relief"
    }
  ],
  "schema_version": "2026-08-05",
  "inventory_transactions": [
    {
      "type": "addition",
      "notes": "Received 4 sticks, PO to Midwest Steel.",
      "days_ago": 34,
      "part_ref": "p_bar1018_1",
      "quantity": 576,
      "author_index": 0,
      "location_ref": "loc_raw_a"
    },
    {
      "type": "depletion",
      "notes": "Cut blanks for WIDGET-100.",
      "job_ref": "j_apex_widgets",
      "days_ago": 12,
      "part_ref": "p_bar1018_1",
      "quantity": 46,
      "author_index": 1,
      "location_ref": "loc_raw_a"
    },
    {
      "type": "addition",
      "days_ago": 30,
      "part_ref": "p_bar4140",
      "quantity": 432,
      "author_index": 0,
      "location_ref": "loc_raw_b"
    },
    {
      "type": "addition",
      "notes": "One full sheet.",
      "days_ago": 28,
      "part_ref": "p_plate6061_25",
      "quantity": 1728,
      "author_index": 0,
      "location_ref": "loc_raw_c"
    },
    {
      "type": "depletion",
      "notes": "Bracket blanks, 100 off.",
      "job_ref": "j_helix_brackets",
      "days_ago": 16,
      "part_ref": "p_plate6061_25",
      "quantity": 1400,
      "author_index": 2,
      "location_ref": "loc_raw_c"
    },
    {
      "type": "addition",
      "days_ago": 22,
      "part_ref": "p_plate7075",
      "quantity": 864,
      "author_index": 0,
      "location_ref": "loc_raw_c"
    },
    {
      "type": "addition",
      "notes": "Batch of 25 off the Mazak.",
      "days_ago": 20,
      "part_ref": "p_sub_blank",
      "quantity": 25,
      "author_index": 1,
      "location_ref": "loc_shelf1_a"
    },
    {
      "type": "depletion",
      "job_ref": "j_apex_widgets",
      "days_ago": 12,
      "part_ref": "p_sub_blank",
      "quantity": 25,
      "author_index": 1,
      "location_ref": "loc_shelf1_a"
    },
    {
      "type": "addition",
      "days_ago": 18,
      "part_ref": "p_sub_bracket",
      "quantity": 50,
      "author_index": 2,
      "location_ref": "loc_shelf1_a"
    },
    {
      "type": "addition",
      "days_ago": 15,
      "part_ref": "p_sub_shaft",
      "quantity": 30,
      "author_index": 1,
      "location_ref": "loc_shelf1_b"
    },
    {
      "type": "depletion",
      "job_ref": "j_iron_shafts",
      "days_ago": 9,
      "part_ref": "p_sub_shaft",
      "quantity": 30,
      "author_index": 1,
      "location_ref": "loc_shelf1_b"
    },
    {
      "type": "addition",
      "notes": "Box of 1000, Fastener Depot.",
      "days_ago": 26,
      "part_ref": "p_shcs14",
      "quantity": 1000,
      "author_index": 0,
      "location_ref": "loc_hw_1"
    },
    {
      "type": "depletion",
      "notes": "4 per widget, 25 widgets.",
      "job_ref": "j_apex_widgets",
      "days_ago": 2,
      "part_ref": "p_shcs14",
      "quantity": 100,
      "author_index": 1,
      "location_ref": "loc_hw_1"
    },
    {
      "type": "depletion",
      "job_ref": "j_apex_widgets",
      "days_ago": 2,
      "part_ref": "p_oring",
      "quantity": 25,
      "author_index": 1,
      "location_ref": "loc_hw_2"
    },
    {
      "type": "depletion",
      "notes": "2 per bracket, 62 done.",
      "job_ref": "j_helix_brackets",
      "days_ago": 2,
      "part_ref": "p_insert",
      "quantity": 124,
      "author_index": 2,
      "location_ref": "loc_hw_3"
    },
    {
      "type": "addition",
      "days_ago": 24,
      "part_ref": "p_bushing",
      "quantity": 240,
      "author_index": 0,
      "location_ref": "loc_hw_2"
    },
    {
      "type": "depletion",
      "notes": "Two chipped on the 7075 manifold.",
      "days_ago": 6,
      "part_ref": "p_endmill",
      "quantity": 2,
      "author_index": 3,
      "location_ref": "loc_crib"
    },
    {
      "type": "depletion",
      "notes": "Refilled the ST-30 tank.",
      "days_ago": 5,
      "part_ref": "p_coolant",
      "quantity": 5,
      "author_index": 2,
      "location_ref": "loc_crib"
    },
    {
      "type": "addition",
      "days_ago": 19,
      "part_ref": "p_bar303",
      "quantity": 288,
      "author_index": 0,
      "location_ref": "loc_raw_b"
    },
    {
      "type": "addition",
      "notes": "Stocked for the Vertex order.",
      "days_ago": 7,
      "part_ref": "p_bought_knob",
      "quantity": 120,
      "author_index": 0,
      "location_ref": "loc_shelf2_a"
    },
    {
      "type": "adjustment",
      "notes": "Cycle count found two extra behind the bin.",
      "days_ago": 4,
      "part_ref": "p_sub_blank",
      "quantity": 2,
      "author_index": 1,
      "location_ref": "loc_shelf1_a"
    }
  ]
}$json$::jsonb)
ON CONFLICT (name, version) DO UPDATE
   SET is_active = EXCLUDED.is_active,
       template_data = EXCLUDED.template_data;
