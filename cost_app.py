import streamlit as st
import pandas as pd
import numpy as np

st.set_page_config(layout="wide")

st.title("📊 Cost Control Analysis Tool")

# =========================
# INPUT SECTION
# =========================
st.header("1. Input Data")

uploaded_file = st.file_uploader("Upload Excel File (Preferred for accuracy)", type=["xlsx"])

if uploaded_file:
    df = pd.read_excel(uploaded_file)
else:
    st.warning("Or manually input sample data below")

    df = pd.DataFrame({
        "CSI": ["03", "09", "15"],
        "Package": ["Concrete", "Finishes", "MEP"],
        "Description": ["Foundations", "Painting", "HVAC"],
        "BAC": [1000000, 500000, 800000],
        "AC_LM": [400000, 200000, 300000],
        "AC_CM": [550000, 260000, 420000],
        "EV_LM": [350000, 180000, 250000],
        "EV_CM": [450000, 210000, 300000]
    })

df = st.data_editor(df, use_container_width=True)

# =========================
# PROCESSING
# =========================
st.header("2. Analysis")

if st.button("Run Analysis"):

    df["ΔAC"] = df["AC_CM"] - df["AC_LM"]
    df["ΔEV"] = df["EV_CM"] - df["EV_LM"]
    df["CV"] = df["EV_CM"] - df["AC_CM"]
    df["CPI"] = df["EV_CM"] / df["AC_CM"]

    # =========================
    # KPI
    # =========================
    total_dac = df["ΔAC"].sum()
    total_cv = df["CV"].sum()
    avg_cpi = df["CPI"].mean()

    col1, col2, col3 = st.columns(3)
    col1.metric("Total ΔAC", f"{total_dac:,.0f}")
    col2.metric("Total CV", f"{total_cv:,.0f}")
    col3.metric("Avg CPI", f"{avg_cpi:.2f}")

    # =========================
    # TABLE
    # =========================
    st.subheader("Detailed Table")
    st.dataframe(df, use_container_width=True)

    # =========================
    # TOP CONCERNS
    # =========================
    st.subheader("⚠️ Top Concerns")

    top_cost = df.sort_values("ΔAC", ascending=False).head(1)
    worst_cpi = df.sort_values("CPI").head(1)
    worst_cv = df.sort_values("CV").head(1)

    st.write("1. Highest Cost Increase:")
    st.write(top_cost[["CSI", "Package", "ΔAC"]])

    st.write("2. Worst CPI:")
    st.write(worst_cpi[["CSI", "Package", "CPI"]])

    st.write("3. Worst CV:")
    st.write(worst_cv[["CSI", "Package", "CV"]])

    # =========================
    # SMART INSIGHTS
    # =========================
    st.subheader("🧠 Executive Summary")

    insights = []

    for _, row in df.iterrows():
        if row["CPI"] < 0.85:
            insights.append(f"{row['Package']} (CSI {row['CSI']}) shows critical inefficiency (CPI={row['CPI']:.2f})")

        elif row["ΔAC"] > 0 and row["ΔEV"] <= 0:
            insights.append(f"{row['Package']} is consuming cost without progress")

        elif row["CPI"] >= 1:
            insights.append(f"{row['Package']} is performing efficiently")

    summary = f"""
    Overall performance shows average CPI of {avg_cpi:.2f}.
    Total cost change is {total_dac:,.0f} with CV at {total_cv:,.0f}.
    
    Key observations:
    - {"; ".join(insights[:3])}
    """

    st.info(summary)
